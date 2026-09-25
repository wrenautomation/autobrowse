/**
 * A person's own details: who they are and where their cards bill. First
 * class beside the cards (William, 2026-09-25): sealed under the wallet's
 * keychain item, backed up to SSM /wallet/profiles (the machine roles'
 * `NeverTheWallet` Deny covers it), never on the box. A card names its
 * owner; a checkout's billing fields come from that owner's address.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  GetParametersByPathCommand,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import type { Cipher } from "credvault";
import { z } from "zod";

export const addressSchema = z.object({
  line1: z.string().trim().min(1),
  line2: z.string().trim().optional(),
  city: z.string().trim().min(1),
  /** As a form spells it out: "Alberta". */
  region: z.string().trim().min(1),
  /** As a form abbreviates it: "AB". */
  regionCode: z.string().trim().min(1),
  postal: z
    .string()
    .trim()
    .transform((p) => p.toUpperCase()),
  /** ISO 3166 alpha-2: "CA". */
  country: z
    .string()
    .trim()
    .length(2)
    .transform((c) => c.toUpperCase()),
});
export type Address = z.infer<typeof addressSchema>;

export const profileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "id: lowercase letters, digits, dashes"),
  name: z.string().trim().min(1),
  /** YYYY-MM-DD. */
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  gender: z.string().trim().optional(),
  address: addressSchema.optional(),
});
export type Profile = z.infer<typeof profileSchema>;

const COUNTRY_NAMES: Readonly<Record<string, string>> = { CA: "Canada", US: "United States" };

/** One line for a listing: the address is the person's own, so it shows whole here. */
export function describeProfile(p: Profile): string {
  const a = p.address;
  return [
    `${p.id}: ${p.name}`,
    p.birthday ? `born ${p.birthday}` : null,
    p.gender ?? null,
    a
      ? `${[a.line1, a.line2].filter(Boolean).join(", ")}, ${a.city} ${a.regionCode} ${a.postal}, ${a.country}`
      : "no address",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A billing field by name after `card.` (`address1`, `city`, `region`, …); null when the profile has none. */
export function addressField(a: Address | undefined, field: string): string | null {
  if (!a) return null;
  switch (field) {
    case "address1":
      return a.line1;
    case "address2":
      return a.line2 ?? null;
    case "city":
      return a.city;
    case "region":
      return a.region;
    case "regionCode":
      return a.regionCode;
    case "postal":
      return a.postal;
    case "country":
      return a.country;
    case "countryName":
      return COUNTRY_NAMES[a.country] ?? a.country;
    default:
      return null;
  }
}

export const ADDRESS_FIELDS = [
  "address1",
  "address2",
  "city",
  "region",
  "regionCode",
  "postal",
  "country",
  "countryName",
] as const;

export interface ProfileStore {
  list(): Promise<Profile[]>;
  put(p: Profile): Promise<void>;
}

/** Sealed file, whole, 0600, through a rename. */
export function fileProfiles(path: string, cipher: Cipher): ProfileStore {
  const read = (): Profile[] =>
    existsSync(path)
      ? z.array(profileSchema).parse(JSON.parse(cipher.open(readFileSync(path, "utf8"))))
      : [];
  return {
    list: async () => read(),
    async put(p) {
      const all = [...read().filter((x) => x.id !== p.id), profileSchema.parse(p)];
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, cipher.seal(JSON.stringify(all)), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

export const PROFILES_SSM_PATH = "/wallet/profiles";

export function ssmProfiles(ssm: Pick<SSMClient, "send">, path = PROFILES_SSM_PATH): ProfileStore {
  return {
    async list() {
      const out: Profile[] = [];
      let NextToken: string | undefined;
      do {
        const r = await ssm.send(
          new GetParametersByPathCommand({ Path: path, WithDecryption: true, NextToken }),
        );
        for (const p of r.Parameters ?? [])
          out.push(profileSchema.parse(JSON.parse(p.Value ?? "")));
        NextToken = r.NextToken;
      } while (NextToken);
      return out;
    },
    async put(p) {
      await ssm.send(
        new PutParameterCommand({
          Name: `${path}/${p.id}`,
          Value: JSON.stringify(profileSchema.parse(p)),
          Type: "SecureString",
          Overwrite: true,
          Description: "profile backup",
        }),
      );
    },
  };
}

/** The file, backed up on every put; an empty file is filled from the backup on first read. */
export function backedUpProfiles(local: ProfileStore, backup: ProfileStore): ProfileStore {
  return {
    async list() {
      const here = await local.list();
      if (here.length) return here;
      const there = await backup.list().catch(() => []);
      for (const p of there) await local.put(p);
      return there;
    },
    async put(p) {
      await local.put(p);
      try {
        await backup.put(p);
      } catch (err) {
        throw new Error(
          `${p.id}: saved on this Mac, but its SSM backup failed (rerun once AWS is signed in): ${(err as Error).name}`,
        );
      }
    },
  };
}

/** The profile a card bills to: its owner, else the only profile there is. */
export function ownerOf(all: readonly Profile[], owner: string | undefined): Profile | null {
  if (owner) return all.find((p) => p.id === owner) ?? null;
  return all.length === 1 ? (all[0] ?? null) : null;
}
