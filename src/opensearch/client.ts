import { DriverNotInstalledError, SearchError } from "../errors.js";
import type { SearchConfig } from "../types.js";

const OPENSEARCH_PKG = "@opensearch-project/opensearch";
const AWS_CREDENTIALS_PKG = "@aws-sdk/credential-provider-node";

/**
 * Minimal structural type for the OpenSearch client.
 *
 * Deliberately NOT `import type { Client } from "@opensearch-project/opensearch"`.
 * That package is an optional peer — importing its types would embed them in our
 * published .d.ts and break typechecking for consumers who installed a different
 * driver. The `any` on responses is contained here, at the untyped boundary.
 */
export interface OpenSearchClientLike {
  indices: {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    create(params: Record<string, unknown>): Promise<any>;
    delete(params: Record<string, unknown>): Promise<any>;
    exists(params: Record<string, unknown>): Promise<any>;
    getMapping(params: Record<string, unknown>): Promise<any>;
  };
  index(params: Record<string, unknown>): Promise<any>;
  get(params: Record<string, unknown>): Promise<any>;
  delete(params: Record<string, unknown>): Promise<any>;
  bulk(params: Record<string, unknown>): Promise<any>;
  search(params: Record<string, unknown>): Promise<any>;
  close(): Promise<any>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

type ClientConstructor = new (options: Record<string, unknown>) => OpenSearchClientLike;

async function loadModule(pkg: string, driver: string): Promise<Record<string, unknown>> {
  try {
    return (await import(/* @vite-ignore */ pkg)) as Record<string, unknown>;
  } catch (cause) {
    throw new DriverNotInstalledError(driver, pkg, { cause });
  }
}

/**
 * SigV4 is the realistic auth mode for AWS-managed OpenSearch on Lambda, but it
 * needs the client's `/aws` entrypoint plus the AWS credential provider. Both are
 * loaded lazily so consumers using basic auth never install them.
 */
async function buildAwsSigV4Options(
  region: string,
  service: "es" | "aoss",
): Promise<Record<string, unknown>> {
  const awsMod = await loadModule(`${OPENSEARCH_PKG}/aws`, "opensearch");
  const credsMod = await loadModule(AWS_CREDENTIALS_PKG, "opensearch");

  const signerFactory = awsMod["AwsSigv4Signer"];
  const defaultProvider = credsMod["defaultProvider"];

  if (typeof signerFactory !== "function" || typeof defaultProvider !== "function") {
    throw new SearchError(
      "search-switch: could not resolve AwsSigv4Signer / defaultProvider from the installed AWS packages",
    );
  }

  return signerFactory({
    region,
    service,
    getCredentials: () => defaultProvider()(),
  }) as Record<string, unknown>;
}

export async function createOpenSearchClient(
  config: SearchConfig,
): Promise<OpenSearchClientLike> {
  const mod = await loadModule(OPENSEARCH_PKG, "opensearch");
  const Client = mod["Client"] as ClientConstructor | undefined;

  if (typeof Client !== "function") {
    throw new SearchError(
      `search-switch: "${OPENSEARCH_PKG}" did not export a Client constructor`,
    );
  }

  const options: Record<string, unknown> = { node: config.node };

  if (config.requestTimeoutMs !== undefined) {
    options["requestTimeout"] = config.requestTimeoutMs;
  }

  const auth = config.auth;
  if (auth !== undefined) {
    switch (auth.kind) {
      case "basic":
        options["auth"] = { username: auth.username, password: auth.password };
        break;

      case "apiKey":
        // The OpenSearch JS client has no first-class API-key auth (unlike
        // Elasticsearch), so it goes on as a header.
        options["headers"] = { authorization: `ApiKey ${auth.apiKey}` };
        break;

      case "awsSigV4":
        Object.assign(options, await buildAwsSigV4Options(auth.region, auth.service));
        break;
    }
  }

  return new Client(options);
}
