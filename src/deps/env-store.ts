/**
 * The one place a secret lives across machines: SSM Parameter Store, one
 * SecureString per name under `/autobrowse/config/`. KMS at rest, IAM at
 * the door, every read in CloudTrail. Prod's `keep` writes here and the box
 * reads it at deploy; `autobrowse env` moves values in and out from a
 * laptop without printing them. Values never enter argv, logs or errors.
 */
import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  ParameterNotFound,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";

export const ENV_STORE_PREFIX = "/autobrowse/config";

/** SSM throttles writes at a few a second; a push of thirty keys backs off and goes on rather than dying. */
async function patient<T>(
  call: () => Promise<T>,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const throttled =
        err instanceof Error &&
        (err.name === "ThrottlingException" || /Rate exceeded/i.test(err.message));
      if (!throttled || attempt >= 8) throw err;
      await sleep(200 * 2 ** attempt);
    }
  }
}

export const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

export interface EnvEntry {
  name: string;
  value: string;
}

export interface EnvStore {
  /** Names and when each changed; never values. */
  list(): Promise<Array<{ name: string; updatedAt: string | null }>>;
  get(name: string): Promise<string | null>;
  /** Every entry, decrypted: what `pull` and the box's deploy read. */
  all(): Promise<EnvEntry[]>;
  put(name: string, value: string): Promise<void>;
  remove(name: string): Promise<boolean>;
}

/** SSM under `prefix`: `/prefix/NAME`. The client comes in so tests pass a fake. */
export function ssmEnvStore(ssm: SSMClient, prefix = ENV_STORE_PREFIX): EnvStore {
  const path = (name: string) => {
    if (!ENV_KEY.test(name)) throw new Error(`env store: bad name ${name}`);
    return `${prefix}/${name}`;
  };
  const nameOf = (p: string | undefined) => p?.slice(prefix.length + 1) ?? "";
  const page = async (withDecryption: boolean) => {
    const out: Array<{ name: string; value: string; updatedAt: string | null }> = [];
    let next: string | undefined;
    do {
      const r = await patient(() =>
        ssm.send(
          new GetParametersByPathCommand({
            Path: prefix,
            Recursive: false,
            WithDecryption: withDecryption,
            NextToken: next,
          }),
        ),
      );
      for (const p of r.Parameters ?? [])
        out.push({
          name: nameOf(p.Name),
          value: p.Value ?? "",
          updatedAt: p.LastModifiedDate?.toISOString() ?? null,
        });
      next = r.NextToken;
    } while (next);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };
  return {
    list: async () => (await page(false)).map(({ name, updatedAt }) => ({ name, updatedAt })),
    all: async () => (await page(true)).map(({ name, value }) => ({ name, value })),
    async get(name) {
      try {
        const r = await ssm.send(
          new GetParameterCommand({ Name: path(name), WithDecryption: true }),
        );
        return r.Parameter?.Value ?? null;
      } catch (err) {
        if (err instanceof ParameterNotFound) return null;
        throw err;
      }
    },
    async put(name, value) {
      if (!value) throw new Error(`env store: ${name} is empty`);
      await patient(() =>
        ssm.send(
          new PutParameterCommand({
            Name: path(name),
            Value: value,
            Type: "SecureString",
            // Past 4 KB (a service-account JSON) SSM needs the advanced tier; this picks it only then.
            Tier: "Intelligent-Tiering",
            Overwrite: true,
          }),
        ),
      );
    },
    async remove(name) {
      try {
        await ssm.send(new DeleteParameterCommand({ Name: path(name) }));
        return true;
      } catch (err) {
        if (err instanceof ParameterNotFound) return false;
        throw err;
      }
    },
  };
}

export function memoryEnvStore(initial: Record<string, string> = {}): EnvStore & {
  values: Record<string, string>;
} {
  const values = { ...initial };
  return {
    values,
    list: async () =>
      Object.keys(values)
        .sort()
        .map((name) => ({ name, updatedAt: null })),
    all: async () =>
      Object.entries(values)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => ({ name, value })),
    get: async (name) => values[name] ?? null,
    async put(name, value) {
      if (!ENV_KEY.test(name)) throw new Error(`env store: bad name ${name}`);
      values[name] = value;
    },
    async remove(name) {
      const had = name in values;
      delete values[name];
      return had;
    },
  };
}

/**
 * `KEY=VALUE` lines → entries. Comments, blanks and quotes as a shell would
 * read them; a value naming a readable file whose content is JSON (a
 * service account) is inlined so the store holds the secret, not a path.
 */
export function parseDotenv(text: string, readFile?: (path: string) => string | null): EnvEntry[] {
  const out: EnvEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const name = line
      .slice(0, i)
      .trim()
      .replace(/^export\s+/, "");
    let value = line.slice(i + 1).trim();
    const q = value[0];
    if (q === '"' || q === "'") {
      const end = value.indexOf(q, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else value = value.replace(/\s+#.*$/, "");
    if (!ENV_KEY.test(name) || !value) continue;
    if (readFile && !value.trimStart().startsWith("{") && /\.json$/.test(value)) {
      const inlined = readFile(value);
      if (inlined?.trimStart().startsWith("{")) value = inlined;
    }
    out.push({ name, value });
  }
  return out;
}

/** Entries → `KEY=VALUE` lines. A multi-line value cannot live in one line: `files` takes it and the line names the path. */
export function toDotenv(
  entries: EnvEntry[],
  files?: (name: string, value: string) => string,
): string {
  return `${entries
    .map(({ name, value }) => {
      if (!/[\r\n]/.test(value)) return `${name}=${value}`;
      if (!files) throw new Error(`${name} spans lines; give it a file`);
      return `${name}=${files(name, value)}`;
    })
    .join("\n")}\n`;
}

/** Entries → `export KEY='…'` lines for `eval "$(…)"`; single quotes are the one thing escaped. */
export function toExports(entries: EnvEntry[]): string {
  return `${entries
    .map(({ name, value }) => `export ${name}='${value.replace(/'/g, `'\\''`)}'`)
    .join("\n")}\n`;
}

/** Upsert `entries` into an env file's text; other lines untouched. */
export function upsertDotenv(text: string, entries: EnvEntry[]): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const { name, value } of entries) {
    const line = `${name}=${value}`;
    const i = lines.findIndex((l) => l.startsWith(`${name}=`));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}
