import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import { TlsConfig } from "./config";

export interface ResolvedTls {
  readonly zone?: route53.IHostedZone;
  readonly certificate?: acm.ICertificate;
}

/**
 * Certificate and optional Route53 zone for a public ALB, following the indexer's convention:
 * an imported certificate ARN wins; otherwise a hosted zone gets a DNS-validated certificate (and the
 * pattern creates the alias record). Neither means HTTP only (non-prod, validated in config.ts).
 */
export function resolveTls(scope: Construct, tls: TlsConfig): ResolvedTls {
  const zone = tls.hostedZoneId
    ? route53.HostedZone.fromHostedZoneAttributes(scope, "Zone", {
        hostedZoneId: tls.hostedZoneId,
        zoneName: tls.hostedZoneName!,
      })
    : undefined;
  let certificate: acm.ICertificate | undefined;
  if (tls.certificateArn) {
    certificate = acm.Certificate.fromCertificateArn(scope, "Cert", tls.certificateArn);
  } else if (zone) {
    certificate = new acm.Certificate(scope, "Cert", {
      domainName: tls.domainName!,
      validation: acm.CertificateValidation.fromDns(zone),
    });
  }
  return { zone, certificate };
}
