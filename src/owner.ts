/**
 * Owners: one autobrowse, many tenants (designs/2026-09-30-owner-keys.md).
 * An owner has its own accounts, files, SSM path, Keychain item and Restate
 * names; one process serves one owner. The default owner keeps every name
 * from before owners existed, so nothing Wren already stored moves.
 */
import { checkOwner, OWNER_NAME, ownerCredentials } from "credvault";

export { checkOwner, OWNER_NAME };

export const DEFAULT_OWNER = "wren";

export const isDefaultOwner = (owner: string): boolean => owner === DEFAULT_OWNER;

/** A Restate name for this owner: the name itself for the default owner, `<name>_<owner>` otherwise (Restate forbids only `/`). */
export const named = (base: string, owner: string = DEFAULT_OWNER): string =>
  isDefaultOwner(owner) ? base : `${base}_${checkOwner(owner)}`;

/** Where an owner's things sit in SSM and S3. */
export function ownerKeys(owner: string) {
  if (isDefaultOwner(owner))
    return { ssm: "/autobrowse/config", shots: "", inputs: "inputs/" } as const;
  checkOwner(owner);
  return {
    ssm: `/autobrowse/owners/${owner}/config`,
    shots: `owners/${owner}/`,
    inputs: `inputs/owners/${owner}/`,
  } as const;
}

export interface AwsConfig {
  region: string;
  credentials?: ReturnType<typeof ownerCredentials>;
}

const sessions = new Map<string, ReturnType<typeof ownerCredentials>>();

/**
 * Every AWS client autobrowse makes takes its config from here. The
 * default owner uses the process's own credentials; any other owner, the
 * shared owners role with its tag, or nothing at all (fail closed). One
 * session per owner and region for the process.
 */
export function awsConfig(o: {
  owner: string;
  ownerRoleArn?: string | undefined;
  region: string;
}): AwsConfig {
  if (isDefaultOwner(o.owner)) return { region: o.region };
  const owner = checkOwner(o.owner);
  if (!o.ownerRoleArn)
    throw new Error(
      `owner ${owner}: AWS needs AUTOBROWSE_OWNER_ROLE_ARN (terraform output owner_role_arn)`,
    );
  const key = `${o.ownerRoleArn}|${owner}|${o.region}`;
  let credentials = sessions.get(key);
  if (!credentials) {
    credentials = ownerCredentials({ roleArn: o.ownerRoleArn, owner, region: o.region });
    sessions.set(key, credentials);
  }
  return { region: o.region, credentials };
}

/** The same, from the environment, for code that runs without settings (a worker's file fetch). */
export const awsConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): AwsConfig =>
  awsConfig({
    owner: env.AUTOBROWSE_OWNER || DEFAULT_OWNER,
    ownerRoleArn: env.AUTOBROWSE_OWNER_ROLE_ARN,
    region: env.AWS_REGION || "us-east-1",
  });
