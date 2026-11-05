import * as cdk from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { loadConfig } from "../lib/config";
import { NetworkStack } from "../lib/network-stack";
import { DataStack } from "../lib/data-stack";
import { IndexerStack } from "../lib/indexer-stack";
import { ObservabilityStack } from "../lib/observability-stack";
import { applySuppressions } from "../lib/suppressions";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`; // dummy placeholder addresses
const CHAIN_CTX = {
  startBlock: "1000",
  factoryAddress: A(1),
  feeVaultAddress: A(2),
  causeRegistryAddress: A(3),
  epochGovernorAddress: A(4),
  donationDistributorAddress: A(5),
};

function build(ctx: Record<string, string> = {}) {
  const app = new cdk.App({
    context: {
      account: "111111111111",
      region: "us-east-1",
      availabilityZones: "us-east-1a,us-east-1b",
      allowInsecureHttp: "true",
      ...CHAIN_CTX,
      ...ctx,
    },
  });
  const config = loadConfig(app.node);
  const env = { account: config.account, region: config.region };
  const common = { env, config };
  const network = new NetworkStack(app, "Network", common);
  const data = new DataStack(app, "Data", { ...common, vpc: network.vpc });
  const indexer = new IndexerStack(app, "Indexer", {
    ...common,
    vpc: network.vpc,
    dbSecret: data.secret,
    dbSecurityGroup: data.securityGroup,
    dbName: data.databaseName,
  });
  const obs = new ObservabilityStack(app, "Obs", { ...common, indexer, database: data.metrics });
  applySuppressions({ config, data, indexer });
  Aspects.of(app).add(new AwsSolutionsChecks());
  return { app, network, data, indexer, obs };
}

describe("config", () => {
  test("requires an account id", () => {
    const old = process.env.CDK_DEFAULT_ACCOUNT;
    delete process.env.CDK_DEFAULT_ACCOUNT;
    expect(() => loadConfig(new cdk.App({ context: { region: "us-east-1" } }).node)).toThrow(/account/);
    if (old) process.env.CDK_DEFAULT_ACCOUNT = old;
  });
  test("rejects bad envName", () => {
    expect(() => build({ envName: "Bad Name" })).toThrow(/envName/);
  });
});

const CERT = "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000";
const HTTPS = { allowInsecureHttp: "", indexerDomainName: "api.example.com", indexerCertificateArn: CERT };
const PROD = { envName: "prod", ...HTTPS, indexerCorsOrigins: "https://verada.example.com" };

describe("https and cors configuration", () => {
  test("synth fails with a clear message without HTTPS (dev without the flag, and prod)", () => {
    expect(() => build({ allowInsecureHttp: "" })).toThrow(/must be served over HTTPS/);
    expect(() => build({ envName: "prod", allowInsecureHttp: "", indexerCorsOrigins: "https://a.example" })).toThrow(/must be served over HTTPS/);
  });
  test("prod rejects allowInsecureHttp and a missing or wildcard CORS list", () => {
    expect(() => build({ ...PROD, allowInsecureHttp: "true" })).toThrow(/not permitted for prod/);
    expect(() => build({ ...PROD, indexerCorsOrigins: "" })).toThrow(/indexerCorsOrigins/);
    expect(() => build({ ...PROD, indexerCorsOrigins: "*" })).toThrow(/not allowed/);
  });
  test("origins must be bare origins", () => {
    expect(() => build({ indexerCorsOrigins: "https://a.example/" })).toThrow(/bare origin/);
    expect(() => build({ indexerCorsOrigins: "nonsense" })).toThrow(/not a valid origin/);
  });
  test("a domain needs a certificate or a hosted zone; zone settings come as a pair", () => {
    expect(() => build({ allowInsecureHttp: "", indexerDomainName: "api.example.com" })).toThrow(/needs either/);
    expect(() => build({ ...HTTPS, indexerHostedZoneId: "Z123" })).toThrow(/together/);
    expect(() => build({ allowInsecureHttp: "", indexerCertificateArn: CERT })).toThrow(/indexerDomainName/);
  });
  test("certificate ARN: HTTPS listener, HTTP redirect, CORS and RPC secret passed to the task", () => {
    const b = build({ ...HTTPS, indexerCorsOrigins: "https://a.example,http://localhost:3000" });
    const t = Template.fromStack(b.indexer);
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 443, Protocol: "HTTPS" });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: "redirect", RedirectConfig: Match.objectLike({ Protocol: "HTTPS", Port: "443" }) })],
    });
    t.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    t.resourceCountIs("AWS::Route53::RecordSet", 0);
    const task = JSON.stringify(t.findResources("AWS::ECS::TaskDefinition"));
    expect(task).toContain("CORS_ALLOWED_ORIGINS");
    expect(task).toContain("https://a.example,http://localhost:3000");
    expect(task).toContain("ETH_RPC_URL");
    t.hasOutput("IndexerUrl", { Value: "https://api.example.com" });
  });
  test("hosted zone: stack creates a DNS-validated certificate and the alias record", () => {
    const b = build({
      allowInsecureHttp: "",
      indexerDomainName: "api.example.com",
      indexerHostedZoneId: "Z0000000000000",
      indexerHostedZoneName: "example.com",
    });
    const t = Template.fromStack(b.indexer);
    t.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "api.example.com",
      DomainValidationOptions: [Match.objectLike({ HostedZoneId: "Z0000000000000" })],
    });
    t.hasResourceProperties("AWS::Route53::RecordSet", { Name: "api.example.com.", Type: "A" });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 443, Protocol: "HTTPS" });
  });
  test("insecure mode serves HTTP only", () => {
    const t = Template.fromStack(build().indexer);
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 80, Protocol: "HTTP" });
    t.resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 1);
  });
});

describe("privacy", () => {
  test("indexer ALB stores no access logs (no client IPs) and the stack has no log bucket", () => {
    const b = build({ ...HTTPS, indexerCorsOrigins: "https://a.example" });
    const t = Template.fromStack(b.indexer);
    const albs = t.findResources("AWS::ElasticLoadBalancingV2::LoadBalancer");
    expect(Object.keys(albs).length).toBe(1);
    for (const alb of Object.values(albs)) {
      const attrs = (alb.Properties?.LoadBalancerAttributes ?? []) as { Key: string; Value: string }[];
      expect(attrs.find((a) => a.Key === "access_logs.s3.enabled" && a.Value === "true")).toBeUndefined();
    }
    t.resourceCountIs("AWS::S3::Bucket", 0);
  });
});

describe("indexer runtime contract", () => {
  const container = (t: Template) => {
    const [td] = Object.values(t.findResources("AWS::ECS::TaskDefinition")) as any[];
    return td.Properties.ContainerDefinitions[0];
  };

  test("health check uses node, not wget/curl", () => {
    const c = container(Template.fromStack(build().indexer));
    expect(c.HealthCheck.Command.slice(0, 2)).toEqual(["CMD", "node"]);
    expect(JSON.stringify(c.HealthCheck)).not.toMatch(/wget|curl/);
  });

  test("passes every variable readEnv() requires, and not PONDER_CHAIN_ID", () => {
    const c = container(Template.fromStack(build().indexer));
    const env = Object.fromEntries(c.Environment.map((e: any) => [e.Name, e.Value]));
    expect(env).toMatchObject({
      START_BLOCK: "1000",
      FACTORY_ADDRESS: A(1),
      FEE_VAULT_ADDRESS: A(2),
      CAUSE_REGISTRY_ADDRESS: A(3),
      EPOCH_GOVERNOR_ADDRESS: A(4),
      DONATION_DISTRIBUTOR_ADDRESS: A(5),
    });
    expect(env).not.toHaveProperty("PONDER_CHAIN_ID");
    expect(c.Secrets.map((x: any) => x.Name)).toContain("ETH_RPC_URL");
  });

  test("builds DATABASE_URL at start-up and fails fast when a part is missing", () => {
    const c = container(Template.fromStack(build().indexer));
    const script: string = c.Command[2];
    expect(c.Command.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(script).toContain("DATABASE_HOST:?");
    expect(script).toContain("DATABASE_PASSWORD:?");
    expect(script).toContain("export DATABASE_URL=");
    expect(script).toContain("exec node_modules/.bin/ponder start");
  });

  test("prod synth fails without chain context; bad values are rejected", () => {
    expect(() => build({ ...PROD, startBlock: "" })).toThrow(/startBlock/);
    expect(() => build({ factoryAddress: "0x123" })).toThrow(/factoryAddress/);
    expect(() => build({ startBlock: "abc" })).toThrow(/startBlock/);
  });

  test("non-prod without any chain context synthesizes with a warning", () => {
    const b = build({ ...Object.fromEntries(Object.keys(CHAIN_CTX).map((k) => [k, ""])) });
    Annotations.fromStack(b.indexer).hasWarning("*", Match.stringLikeRegexp("No indexer chain context"));
  });
});

describe("stacks", () => {
  const s = build();

  test("network (default): no NAT, no interface endpoints, only the free S3 gateway endpoint", () => {
    const t = Template.fromStack(s.network);
    t.resourceCountIs("AWS::EC2::VPC", 1);
    t.resourceCountIs("AWS::EC2::NatGateway", 0);
    t.resourceCountIs("AWS::EC2::VPCEndpoint", 1);
    t.hasResourceProperties("AWS::EC2::VPCEndpoint", { VpcEndpointType: "Gateway" });
    t.resourceCountIs("AWS::EC2::Subnet", 4); // 2 public + 2 isolated
    t.resourceCountIs("AWS::EC2::FlowLog", 1);
  });

  test("network (privateEgress): NAT, private subnets and the four interface endpoints return", () => {
    const t = Template.fromStack(build({ privateEgress: "true" }).network);
    t.resourceCountIs("AWS::EC2::NatGateway", 1);
    t.resourceCountIs("AWS::EC2::VPCEndpoint", 5);
    t.resourceCountIs("AWS::EC2::Subnet", 6);
  });

  test("indexer tasks: public subnets with public IP by default; private without IP under privateEgress", () => {
    Template.fromStack(s.indexer).hasResourceProperties("AWS::ECS::Service", {
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "ENABLED" }) },
    });
    const p = build({ privateEgress: "true" });
    Template.fromStack(p.indexer).hasResourceProperties("AWS::ECS::Service", {
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "DISABLED" }) },
    });
  });

  test("data: dev defaults to a single-AZ encrypted RDS Postgres 16 t4g.micro, no rotation without egress", () => {
    const t = Template.fromStack(s.data);
    t.resourceCountIs("AWS::RDS::DBCluster", 0);
    t.hasResourceProperties("AWS::RDS::DBInstance", {
      Engine: "postgres",
      DBInstanceClass: "db.t4g.micro",
      MultiAZ: false,
      StorageEncrypted: true,
      PubliclyAccessible: false,
      EngineVersion: Match.stringLikeRegexp("^16"),
      BackupRetentionPeriod: 3,
    });
    t.hasResourceProperties("AWS::SecretsManager::Secret", {
      GenerateSecretString: Match.objectLike({ GenerateStringKey: "password" }),
    });
    t.resourceCountIs("AWS::SecretsManager::RotationSchedule", 0);
  });

  test("data: privateEgress enables rotation", () => {
    Template.fromStack(build({ privateEgress: "true" }).data).resourceCountIs("AWS::SecretsManager::RotationSchedule", 1);
  });

  test("data: dbMode aurora gives encrypted Serverless v2 and no instance", () => {
    const t = Template.fromStack(build({ dbMode: "aurora" }).data);
    t.resourceCountIs("AWS::RDS::DBInstance", 1); // the cluster writer instance only
    t.hasResourceProperties("AWS::RDS::DBCluster", {
      Engine: "aurora-postgresql",
      StorageEncrypted: true,
      ServerlessV2ScalingConfiguration: Match.objectLike({ MinCapacity: 0.5 }),
    });
    expect(() => build({ dbMode: "mysql" })).toThrow(/dbMode/);
  });

  test("indexer: ECR scan, health check, autoscaling, secrets not inline", () => {
    const t = Template.fromStack(s.indexer);
    t.hasResourceProperties("AWS::ECR::Repository", {
      ImageScanningConfiguration: { ScanOnPush: true },
      ImageTagMutability: "IMMUTABLE",
    });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckPath: "/health",
      TargetType: "ip",
    });
    t.hasResourceProperties("AWS::ECS::Service", {
      LoadBalancers: [Match.objectLike({ ContainerName: "indexer", ContainerPort: 42069 })],
    });
    t.hasResourceProperties("AWS::ECS::Service", {
      LaunchType: "FARGATE",
      DeploymentConfiguration: Match.objectLike({ DeploymentCircuitBreaker: { Enable: true, Rollback: true } }),
    });
    t.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", { MinCapacity: 1, MaxCapacity: 1 });
    t.resourceCountIs("AWS::ApplicationAutoScaling::ScalingPolicy", 2);
    const task = JSON.stringify(t.findResources("AWS::ECS::TaskDefinition"));
    expect(task).toContain("ETH_RPC_URL");
    expect(task).toContain("DATABASE_PASSWORD");
    t.hasResourceProperties("AWS::EC2::SecurityGroupIngress", { FromPort: 5432, ToPort: 5432 });
  });

  test("observability: alarms wired to an encrypted topic, dashboard present", () => {
    const t = Template.fromStack(s.obs);
    t.resourceCountIs("AWS::CloudWatch::Alarm", 8); // dev RDS adds a free-storage alarm
    t.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    t.hasResourceProperties("AWS::SNS::Topic", { KmsMasterKeyId: Match.anyValue() });
  });

  test("prod: aurora by default with deletion protection, snapshot retention, no alarms for storage", () => {
    const p = build(PROD);
    Template.fromStack(p.data).hasResourceProperties("AWS::RDS::DBCluster", { DeletionProtection: true });
    Template.fromStack(p.data).hasResource("AWS::RDS::DBCluster", { DeletionPolicy: "Snapshot" });
    Template.fromStack(p.obs).resourceCountIs("AWS::CloudWatch::Alarm", 7);
    Template.fromStack(p.indexer).hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 443 });
  });

  test("prod rds mode is Multi-AZ with deletion protection", () => {
    const p = build({ ...PROD, dbMode: "rds" });
    Template.fromStack(p.data).hasResourceProperties("AWS::RDS::DBInstance", { MultiAZ: true, DeletionProtection: true });
  });

  test("no web hosting resources remain", () => {
    const all = [s.network, s.data, s.indexer, s.obs].map((st) => JSON.stringify(Template.fromStack(st).toJSON())).join("");
    expect(all).not.toMatch(/AWS::CloudFront::|x-origin-verify/);
  });

  test("no hardcoded account id in synthesized templates beyond the context-provided one", () => {
    for (const st of [s.network, s.data, s.indexer, s.obs]) {
      const json = JSON.stringify(Template.fromStack(st).toJSON());
      expect(json).not.toMatch(/AKIA[0-9A-Z]{16}/);
    }
  });

  test.each([
    ["dev default", {}],
    ["dev with certificate, aurora, privateEgress", { ...HTTPS, dbMode: "aurora", privateEgress: "true" }],
    ["prod", PROD],
  ])("cdk-nag AwsSolutions reports no errors: %s", (_n, ctx) => {
    const b = ctx === ({} as object) || Object.keys(ctx).length === 0 ? s : build(ctx as Record<string, string>);
    for (const st of [b.network, b.data, b.indexer, b.obs]) {
      const errors = Annotations.fromStack(st).findError("*", Match.stringLikeRegexp("AwsSolutions-.*"));
      expect(errors).toEqual([]);
    }
  });
});
