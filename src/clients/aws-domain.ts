/**
 * A sending domain's AWS side: its own Route 53 zone (four name servers
 * Route 53 picks per zone, so one blocklisted domain shares nothing with
 * the main one) and a mask: CloudFront serves the main site under the
 * domain's own name, no redirect. The certificate is ACM's, in us-east-1
 * (CloudFront reads only there). Every create looks first, so a rerun
 * after a crash finds what the last one made.
 */
import {
  ACMClient,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  RequestCertificateCommand,
} from "@aws-sdk/client-acm";
import {
  CloudFrontClient,
  CreateDistributionCommand,
  ListDistributionsCommand,
} from "@aws-sdk/client-cloudfront";
import {
  ChangeResourceRecordSetsCommand,
  CreateHostedZoneCommand,
  GetHostedZoneCommand,
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
  type ResourceRecordSet,
  Route53Client,
} from "@aws-sdk/client-route-53";
import type { AwsConfig } from "../owner.js";
import type { DnsRecord } from "./dynadot.js";

/** CloudFront's own zone id for alias records (the same in every account). */
const CLOUDFRONT_ZONE = "Z2FDTNDATAQYW2";
/** Managed policies: nothing cached (the site sets cookies and reads query strings), every viewer header but Host. */
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";

export interface Certificate {
  arn: string;
  /** PENDING_VALIDATION, ISSUED, FAILED, … */
  status: string;
  /** The CNAMEs ACM wants in DNS; empty until ACM has made them. */
  validation: DnsRecord[];
}

export interface Distribution {
  id: string;
  /** dxxxx.cloudfront.net: what the alias records point at. */
  host: string;
  /** InProgress until deployed everywhere, then Deployed. */
  status: string;
}

export interface AwsDomainClient {
  /** The domain's zone, made when absent, with the name servers Route 53 gave it. */
  zone(domain: string): Promise<{ id: string; nameservers: string[] }>;
  /** Every record in the zone but its own SOA and NS. */
  records(zoneId: string, domain: string): Promise<DnsRecord[]>;
  /** Writes these records over whatever the zone has at each name and type. */
  upsert(zoneId: string, domain: string, records: DnsRecord[]): Promise<void>;
  /** A and AAAA at `name` ("@" or "www") aliased to a CloudFront host. */
  alias(zoneId: string, domain: string, name: string, cloudfrontHost: string): Promise<void>;
  /** The domain's certificate (apex + www), requested when absent. */
  certificate(domain: string): Promise<Certificate>;
  /** The distribution serving `origin` as the domain (apex + www), made when absent. */
  mask(domain: string, origin: string, certificateArn: string): Promise<Distribution>;
}

export function awsDomain(aws: AwsConfig): AwsDomainClient {
  const r53 = new Route53Client({ ...aws, region: "us-east-1" });
  const acm = new ACMClient({ ...aws, region: "us-east-1" });
  const cf = new CloudFrontClient({ ...aws, region: "us-east-1" });
  const fqdn = (domain: string, name: string) => `${name === "@" ? domain : `${name}.${domain}`}.`;

  return {
    async zone(domain) {
      const found = await r53.send(
        new ListHostedZonesByNameCommand({ DNSName: domain, MaxItems: 1 }),
      );
      const have = found.HostedZones?.find(
        (z) => z.Name === `${domain}.` && !z.Config?.PrivateZone,
      );
      const id =
        have?.Id ??
        (
          await r53.send(
            new CreateHostedZoneCommand({
              Name: domain,
              CallerReference: `fleet-${domain}-${Date.now()}`,
            }),
          )
        ).HostedZone?.Id;
      if (!id) throw new Error(`Route 53 made no zone for ${domain}`);
      const z = await r53.send(new GetHostedZoneCommand({ Id: id }));
      return { id, nameservers: (z.DelegationSet?.NameServers ?? []).map((n) => n.toLowerCase()) };
    },
    async records(zoneId, domain) {
      const out: DnsRecord[] = [];
      let start: { name?: string | undefined; type?: string | undefined } = {};
      for (;;) {
        const page = await r53.send(
          new ListResourceRecordSetsCommand({
            HostedZoneId: zoneId,
            ...(start.name ? { StartRecordName: start.name } : {}),
            ...(start.type ? { StartRecordType: start.type as never } : {}),
          }),
        );
        for (const set of page.ResourceRecordSets ?? []) out.push(...fromSet(set, domain));
        if (!page.IsTruncated) break;
        start = { name: page.NextRecordName, type: page.NextRecordType };
      }
      return out.filter((r) => !(r.name === "@" && (r.type === "SOA" || r.type === "NS")));
    },
    async upsert(zoneId, domain, records) {
      const sets = new Map<string, ResourceRecordSet>();
      for (const r of records) {
        const key = `${r.name} ${r.type}`;
        const set = sets.get(key) ?? {
          Name: fqdn(domain, r.name),
          Type: r.type as never,
          TTL: 300,
          ResourceRecords: [],
        };
        set.ResourceRecords?.push({ Value: r53Value(r) });
        sets.set(key, set);
      }
      if (sets.size === 0) return;
      await r53.send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: zoneId,
          ChangeBatch: {
            Changes: [...sets.values()].map((s) => ({ Action: "UPSERT", ResourceRecordSet: s })),
          },
        }),
      );
    },
    async alias(zoneId, domain, name, cloudfrontHost) {
      await r53.send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: zoneId,
          ChangeBatch: {
            Changes: (["A", "AAAA"] as const).map((Type) => ({
              Action: "UPSERT",
              ResourceRecordSet: {
                Name: fqdn(domain, name),
                Type,
                AliasTarget: {
                  HostedZoneId: CLOUDFRONT_ZONE,
                  DNSName: cloudfrontHost,
                  EvaluateTargetHealth: false,
                },
              },
            })),
          },
        }),
      );
    },
    async certificate(domain) {
      let arn: string | undefined;
      let next: string | undefined;
      do {
        const page = await acm.send(
          new ListCertificatesCommand({
            CertificateStatuses: ["PENDING_VALIDATION", "ISSUED"],
            ...(next ? { NextToken: next } : {}),
          }),
        );
        arn = page.CertificateSummaryList?.find((c) => c.DomainName === domain)?.CertificateArn;
        next = arn ? undefined : page.NextToken;
      } while (next);
      arn ??= (
        await acm.send(
          new RequestCertificateCommand({
            DomainName: domain,
            SubjectAlternativeNames: [`www.${domain}`],
            ValidationMethod: "DNS",
            // ACM treats a repeat within an hour as the same request.
            IdempotencyToken: domain.replace(/[^a-z0-9]/gi, "").slice(0, 32),
          }),
        )
      ).CertificateArn;
      if (!arn) throw new Error(`ACM made no certificate for ${domain}`);
      const c = (await acm.send(new DescribeCertificateCommand({ CertificateArn: arn })))
        .Certificate;
      const validation = new Map<string, DnsRecord>();
      for (const o of c?.DomainValidationOptions ?? []) {
        const rr = o.ResourceRecord;
        if (rr?.Name && rr.Value)
          validation.set(rr.Name, {
            name: relative(rr.Name, domain),
            type: rr.Type ?? "CNAME",
            value: rr.Value,
          });
      }
      return { arn, status: c?.Status ?? "UNKNOWN", validation: [...validation.values()] };
    },
    async mask(domain, origin, certificateArn) {
      const aliases = [domain, `www.${domain}`];
      let marker: string | undefined;
      do {
        const page = (
          await cf.send(new ListDistributionsCommand({ ...(marker ? { Marker: marker } : {}) }))
        ).DistributionList;
        const hit = page?.Items?.find((d) => d.Aliases?.Items?.includes(domain));
        if (hit?.Id && hit.DomainName)
          return { id: hit.Id, host: hit.DomainName, status: hit.Status ?? "" };
        marker = page?.IsTruncated ? page.NextMarker : undefined;
      } while (marker);
      const made = await cf.send(
        new CreateDistributionCommand({
          DistributionConfig: {
            CallerReference: `fleet-${domain}`,
            Comment: `${domain} shows ${origin}`,
            Enabled: true,
            Aliases: { Quantity: aliases.length, Items: aliases },
            Origins: {
              Quantity: 1,
              Items: [
                {
                  Id: "site",
                  DomainName: origin,
                  CustomOriginConfig: {
                    HTTPPort: 80,
                    HTTPSPort: 443,
                    OriginProtocolPolicy: "https-only",
                    OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
                  },
                },
              ],
            },
            DefaultCacheBehavior: {
              TargetOriginId: "site",
              ViewerProtocolPolicy: "redirect-to-https",
              CachePolicyId: CACHING_DISABLED,
              OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
              Compress: true,
              AllowedMethods: {
                Quantity: 7,
                Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
                CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
              },
            },
            ViewerCertificate: {
              ACMCertificateArn: certificateArn,
              SSLSupportMethod: "sni-only",
              MinimumProtocolVersion: "TLSv1.2_2021",
            },
            PriceClass: "PriceClass_100",
            HttpVersion: "http2and3",
          },
        }),
      );
      const d = made.Distribution;
      if (!d?.Id || !d.DomainName) throw new Error(`CloudFront made no distribution for ${domain}`);
      return { id: d.Id, host: d.DomainName, status: d.Status ?? "" };
    },
  };
}

/** Route 53's value text: TXT quoted in 255-byte strings, MX with its priority. */
export function r53Value(r: DnsRecord): string {
  if (r.type === "TXT") {
    const raw = r.value.replace(/^"|"$/g, "");
    const chunks = raw.match(/.{1,255}/gs) ?? [""];
    return chunks.map((c) => `"${c.replace(/"/g, '\\"')}"`).join(" ");
  }
  if (r.type === "MX") return `${r.priority ?? 10} ${r.value}`;
  return r.value;
}

function fromSet(set: ResourceRecordSet, domain: string): DnsRecord[] {
  const name = relative(set.Name ?? "", domain);
  const type = set.Type ?? "";
  if (set.AliasTarget) return [{ name, type, value: `alias ${set.AliasTarget.DNSName ?? ""}` }];
  return (set.ResourceRecords ?? []).map((rr) => {
    const v = rr.Value ?? "";
    if (type === "TXT")
      return {
        name,
        type,
        value: [...v.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
          .map((m) => (m[1] ?? "").replace(/\\(.)/g, "$1"))
          .join(""),
      };
    if (type === "MX") {
      const [prio, host] = v.split(/\s+/);
      return { name, type, value: host ?? "", priority: Number(prio) };
    }
    return { name, type, value: v };
  });
}

/** "www.example.com." → "www"; the apex → "@". */
function relative(fq: string, domain: string): string {
  const n = fq.toLowerCase().replace(/\.$/, "");
  return n === domain ? "@" : n.endsWith(`.${domain}`) ? n.slice(0, -domain.length - 1) : n;
}
