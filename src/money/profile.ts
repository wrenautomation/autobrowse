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
  /** Where a charge's receipt and invoice go. */
  email: z.string().trim().email().optional(),
  /** Where a charge is texted (E.164). */
  phone: z
    .string()
    .trim()
    .regex(/^\+\d{8,15}$/, "phone: +<country><number>, digits only")
    .optional(),
  /** The sales-tax registration a billing form asks for: a Canadian GST/HST number (`123456789RT0001`). */
  taxId: z
    .string()
    .trim()
    .transform((t) => t.toUpperCase().replace(/\s+/g, ""))
    .optional(),
});
export type Profile = z.infer<typeof profileSchema>;

/** Who hears about a card's charges; a field left out goes to this machine's defaults. */
export interface Contacts {
  email?: string;
  phone?: string;
}

/** A card's own contacts first, then its owner's. */
export function contactsOf(
  card: { email?: string | undefined; phone?: string | undefined },
  owner: Profile | null,
): Contacts {
  const email = card.email ?? owner?.email;
  const phone = card.phone ?? owner?.phone;
  return { ...(email ? { email } : {}), ...(phone ? { phone } : {}) };
}

/**
 * What a billing form's contact fields hold: the card owner's, never the
 * site's login email or whatever it prefilled (William, 2026-10-04).
 */
export interface BillingContacts extends Contacts {
  taxId?: string;
}
export type BillingKind = keyof BillingContacts;

/** Which billing contact an input asks for, from its type, name, id, autocomplete, label, placeholder; null: none. */
export function billingKind(label: string): BillingKind | null {
  const w = label.replace(/[_-]+/g, " ");
  if (/\b(tax ?(id|number)|vat|gst|hst)\b/i.test(w)) return "taxId";
  if (/\be ?mail\b/i.test(w)) return "email";
  if (/\b(phone|mobile|tel)\b/i.test(w)) return "phone";
  return null;
}

/** Whether a field already holds it: emails by case, phones by their last 10 digits, tax ids without spaces. */
export function holdsBilling(kind: BillingKind, have: string, want: string): boolean {
  if (kind === "phone") {
    const d = (s: string) => s.replace(/\D/g, "").slice(-10);
    return d(have).length === 10 && d(have) === d(want);
  }
  const norm = (s: string) =>
    kind === "taxId" ? s.toUpperCase().replace(/\s+/g, "") : s.trim().toLowerCase();
  return norm(have) === norm(want);
}

/** `+15551234567` → `••4567`: enough to know which phone, not the number. */
export const phoneEnding = (p: string) => `••${p.slice(-4)}`;

const COUNTRY_NAMES: Readonly<Record<string, string>> = { CA: "Canada", US: "United States" };

/** One line for a listing: the address is the person's own, so it shows whole here. */
export function describeProfile(p: Profile): string {
  const a = p.address;
  return [
    `${p.id}: ${p.name}`,
    p.birthday ? `born ${p.birthday}` : null,
    p.gender ?? null,
    p.email ? `receipts ${p.email}` : null,
    p.phone ? `texts ${phoneEnding(p.phone)}` : null,
    p.taxId ? `tax id ${p.taxId}` : null,
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

/** A profile field by name after `profile.`: `taxId`, `name`, `email`, `phone`, or an address field; null when it has none. */
export function profileField(p: Profile, field: string): string | null {
  switch (field) {
    case "taxId":
      return p.taxId ?? null;
    case "name":
      return p.name;
    case "email":
      return p.email ?? null;
    case "phone":
      return p.phone ?? null;
    default:
      return addressField(p.address, field);
  }
}

/** `profile.taxId` → the only profile, `taxId`; `profile@william.postal` → profile `william`. Null: not a profile field. */
export function profileSecret(name: string): { id: string | null; field: string } | null {
  const m = /^profile(?:@([a-z0-9-]+))?\.([A-Za-z][A-Za-z0-9]*)$/.exec(name);
  return m ? { id: m[1] ?? null, field: m[2] as string } : null;
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
