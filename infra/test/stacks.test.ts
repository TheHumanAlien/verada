import * as cdk from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { loadConfig } from "../lib/config";
import { NetworkStack } from "../lib/network-stack";
import { DataStack } from "../lib/data-stack";
import { IndexerStack } from "../lib/indexer-stack";
import { ObservabilityStack } from "../lib/observability-stack";
import { SwarmStack } from "../lib/swarm-stack";
import { PublisherStack } from "../lib/publisher-stack";
import { applySuppressions } from "../lib/suppressions";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`; // dummy placeholder addresses
const CHAIN_CTX = {
  startBlock: "1000",
  factoryAddress: A(1),
  feeVaultAddress: A(2),
  causeRegistryAddress: A(3),
  epochGovernorAddress: A(4),
  donationDistributorAddress: A(5),
  feeConsolidatorAddress: A(6),
  quoteRegistryAddress: A(7),
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
  const swarm = new SwarmStack(app, "Swarm", { ...common, vpc: network.vpc });
  const publisher = new PublisherStack(app, "Publisher", { ...common, vpc: network.vpc, bee: swarm.beeApi });
  const obs = new ObservabilityStack(app, "Obs", {
    ...common,
    indexer,
    database: data.metrics,
    services: [
      { id: "Swarm", label: "Swarm gateway", service: swarm.service },
      { id: "Publisher", label: "Publisher", service: publisher.service, logAlarms: publisher.logAlarms },
    ],
  });
  applySuppressions({ config, data, indexer, swarm, publisher });
  Aspects.of(app).add(new AwsSolutionsChecks());
  return { app, network, data, indexer, swarm, publisher, obs };
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
const HTTPS = {
  allowInsecureHttp: "",
  indexerDomainName: "api.example.com",
  indexerCertificateArn: CERT,
  swarmDomainName: "swarm.example.com",
  swarmCertificateArn: CERT,
  publisherDomainName: "publisher.example.com",
  publisherCertificateArn: CERT,
};
const PROD = { envName: "prod", ...HTTPS, indexerCorsOrigins: "https://verada.example.com" };

describe("https and cors configuration", () => {
  test("synth fails with a clear message without HTTPS (dev without the flag, and prod)", () => {
    expect(() => build({ allowInsecureHttp: "" })).toThrow(/must be served over HTTPS/);
    expect(() => build({ envName: "prod", allowInsecureHttp: "", indexerCorsOrigins: "https://a.example" })).toThrow(/must be served over HTTPS/);
    expect(() => build({ ...PROD, swarmCertificateArn: "", swarmDomainName: "" })).toThrow(/Swarm gateway must be served over HTTPS/);
    expect(() => build({ ...PROD, publisherCertificateArn: "", publisherDomainName: "" })).toThrow(/publisher must be served over HTTPS/);
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
  test("catalogue source is passed to the indexer only when set, and must be https", () => {
    const without = JSON.stringify(Template.fromStack(build({ ...HTTPS }).indexer).findResources("AWS::ECS::TaskDefinition"));
    expect(without).not.toContain("CATALOG_SOURCE");
    const src = "https://swarm.example.com/bzz/" + "ab".repeat(32);
    const withSrc = JSON.stringify(
      Template.fromStack(build({ ...HTTPS, indexerCatalogSource: src + "/" }).indexer).findResources("AWS::ECS::TaskDefinition"),
    );
    expect(withSrc).toContain("CATALOG_SOURCE");
    expect(withSrc).toContain(src + '"');
    expect(() => build({ ...HTTPS, indexerCatalogSource: "http://x.example" })).toThrow(/indexerCatalogSource/);
  });
  test("hosted zone: stack creates a DNS-validated certificate and the alias record", () => {
    const b = build({
      ...HTTPS,
      indexerCertificateArn: "",
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

describe("database backup retention", () => {
  test("defaults to 3 days outside prod and accepts an override", () => {
    Template.fromStack(build().data).hasResourceProperties("AWS::RDS::DBInstance", { BackupRetentionPeriod: 3 });
    Template.fromStack(build({ dbBackupRetentionDays: "1" }).data).hasResourceProperties("AWS::RDS::DBInstance", { BackupRetentionPeriod: 1 });
  });
  test("rejects out-of-range values and short prod retention", () => {
    expect(() => build({ dbBackupRetentionDays: "0" })).toThrow(/1 to 35/);
    expect(() => build({ ...PROD, dbBackupRetentionDays: "1" })).toThrow(/at least 7/);
  });
});

describe("indexer behind CloudFront (no custom domain)", () => {
  test("serves HTTPS on the CloudFront domain; the ALB forwards only header-tagged requests", () => {
    const t = Template.fromStack(build({ indexerCloudFront: "true", indexerCloudFrontPrefixListId: "pl-fab65393" }).indexer);
    t.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "https-only" }),
        Origins: [Match.objectLike({ OriginCustomHeaders: [Match.objectLike({ HeaderName: "X-Verada-Origin" })] })],
      }),
    });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      DefaultActions: [Match.objectLike({ Type: "fixed-response" })],
    });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", {
      Priority: 1,
      Conditions: [Match.objectLike({ Field: "http-header" })],
    });
    const ingress = JSON.stringify({
      ...t.findResources("AWS::EC2::SecurityGroup"),
      ...t.findResources("AWS::EC2::SecurityGroupIngress"),
    });
    expect(ingress).toContain('"SourcePrefixListId":"pl-fab65393"');
    // Nothing admits the internet directly (the task's outbound rule is the only 0.0.0.0/0).
    expect(ingress).not.toMatch(/"CidrIp":"0\.0\.0\.0\/0","Description":"Allow from anyone/);
    expect(JSON.stringify(t.findResources("AWS::EC2::SecurityGroupIngress"))).not.toContain("0.0.0.0/0");
    const out = t.findOutputs("IndexerUrl").IndexerUrl?.Value;
    expect(JSON.stringify(out)).toContain("DomainName");
    expect(Annotations.fromStack(build({ indexerCloudFront: "true" }).indexer).findError("*", Match.anyValue())).toHaveLength(0);
  });
  test("is ignored when the ALB already has its own certificate", () => {
    const t = Template.fromStack(build({ ...HTTPS, indexerCloudFront: "true" }).indexer);
    t.resourceCountIs("AWS::CloudFront::Distribution", 0);
  });
  test("rejects a malformed prefix list id", () => {
    expect(() => build({ indexerCloudFront: "true", indexerCloudFrontPrefixListId: "cloudfront" })).toThrow(/prefix list/);
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
      FEE_CONSOLIDATOR_ADDRESS: A(6),
      QUOTE_REGISTRY_ADDRESS: A(7),
      TOKEN_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000000",
      TAKEOVER_GOVERNOR_ADDRESS: "0x0000000000000000000000000000000000000000",
      VOTING_SCHEME_ADDRESS: "0x0000000000000000000000000000000000000000",
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

  test("optional registry/governance addresses pass through when given and are validated", () => {
    const c = container(
      Template.fromStack(build({ tokenRegistryAddress: A(8), takeoverGovernorAddress: A(9), votingSchemeAddress: A(10) }).indexer),
    );
    const env = Object.fromEntries(c.Environment.map((e: any) => [e.Name, e.Value]));
    expect(env).toMatchObject({ TOKEN_REGISTRY_ADDRESS: A(8), TAKEOVER_GOVERNOR_ADDRESS: A(9), VOTING_SCHEME_ADDRESS: A(10) });
    expect(() => build({ votingSchemeAddress: "0x12" })).toThrow(/votingSchemeAddress/);
  });

  test("fee consolidator and quote registry: required in prod, a warning (not an error) outside prod", () => {
    expect(() => build({ ...PROD, feeConsolidatorAddress: "" })).toThrow(/feeConsolidatorAddress/);
    expect(() => build({ ...PROD, quoteRegistryAddress: "" })).toThrow(/quoteRegistryAddress/);
    const b = build({ feeConsolidatorAddress: "", quoteRegistryAddress: "" });
    Annotations.fromStack(b.indexer).hasWarning("*", Match.stringLikeRegexp("feeConsolidatorAddress, quoteRegistryAddress"));
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
    t.resourceCountIs("AWS::CloudWatch::Alarm", 18); // 7 indexer/db + RDS free storage + 4 each for Swarm and publisher + 2 publisher log alarms
    t.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    t.hasResourceProperties("AWS::SNS::Topic", { KmsMasterKeyId: Match.anyValue() });
  });

  test("prod: aurora by default with deletion protection, snapshot retention, no alarms for storage", () => {
    const p = build(PROD);
    Template.fromStack(p.data).hasResourceProperties("AWS::RDS::DBCluster", { DeletionProtection: true });
    Template.fromStack(p.data).hasResource("AWS::RDS::DBCluster", { DeletionPolicy: "Snapshot" });
    Template.fromStack(p.obs).resourceCountIs("AWS::CloudWatch::Alarm", 17);
    Template.fromStack(p.indexer).hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 443 });
  });

  test("prod rds mode is Multi-AZ with deletion protection", () => {
    const p = build({ ...PROD, dbMode: "rds" });
    Template.fromStack(p.data).hasResourceProperties("AWS::RDS::DBInstance", { MultiAZ: true, DeletionProtection: true });
  });

  test("no web hosting resources remain", () => {
    const all = [s.network, s.data, s.indexer, s.swarm, s.publisher, s.obs].map((st) => JSON.stringify(Template.fromStack(st).toJSON())).join("");
    expect(all).not.toMatch(/AWS::CloudFront::|x-origin-verify/);
  });

  test("no hardcoded account id in synthesized templates beyond the context-provided one", () => {
    for (const st of [s.network, s.data, s.indexer, s.swarm, s.publisher, s.obs]) {
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
    for (const st of [b.network, b.data, b.indexer, b.swarm, b.publisher, b.obs]) {
      const errors = Annotations.fromStack(st).findError("*", Match.stringLikeRegexp("AwsSolutions-.*"));
      expect(errors).toEqual([]);
    }
  });
});

describe("swarm", () => {
  const containers = (t: Template) => {
    const [td] = Object.values(t.findResources("AWS::ECS::TaskDefinition")) as any[];
    return Object.fromEntries(td.Properties.ContainerDefinitions.map((c: any) => [c.Name, c]));
  };
  const envOf = (c: any) => Object.fromEntries((c.Environment ?? []).map((e: any) => [e.Name, e.Value]));
  const secretsOf = (c: any) => Object.fromEntries((c.Secrets ?? []).map((x: any) => [x.Name, JSON.stringify(x.ValueFrom)]));
  const https = build(HTTPS);
  const t = Template.fromStack(https.swarm);

  test("one 1 vCPU / 2 GiB task with bee and gateway containers on the pinned images", () => {
    t.hasResourceProperties("AWS::ECS::TaskDefinition", { Cpu: "1024", Memory: "2048", RequiresCompatibilities: ["FARGATE"] });
    const c = containers(t);
    expect(Object.keys(c).sort()).toEqual(["bee", "gateway"]);
    expect(c.bee.Image).toBe("ethersphere/bee:2.8.3");
    expect(c.bee.Command).toEqual(["start"]);
    expect(c.gateway.Image).toBe("ethersphere/swarm-gateway:0.4.0");
    expect(c.gateway.DependsOn).toEqual([{ ContainerName: "bee", Condition: "HEALTHY" }]);
  });

  test("bee: light node with SWAP on mainnet, API on the task interfaces, secrets from verada/<env>/bee", () => {
    const bee = containers(t).bee;
    expect(envOf(bee)).toEqual({
      BEE_API_ADDR: ":1633",
      BEE_DATA_DIR: "/home/bee/.bee",
      BEE_FULL_NODE: "false",
      BEE_SWAP_ENABLE: "true",
      BEE_MAINNET: "true",
    });
    expect(envOf(bee)).not.toHaveProperty("BEE_CORS_ALLOWED_ORIGINS");
    const sec = secretsOf(bee);
    expect(sec.BEE_PASSWORD).toContain("secret:verada/dev/bee:password::");
    expect(sec.BEE_BLOCKCHAIN_RPC_ENDPOINT).toContain("secret:verada/dev/bee:gnosisRpcUrl::");
    expect(bee.HealthCheck.Command.join(" ")).toContain("/dev/tcp/127.0.0.1/1633");
    expect(bee.HealthCheck.Command.join(" ")).toContain("GET /health");
    expect(bee.MountPoints).toEqual([{ ContainerPath: "/home/bee/.bee", ReadOnly: false, SourceVolume: "bee-data" }]);
  });

  test("gateway: talks to bee over loopback, soft auth, postage defaults, 4mb uploads", () => {
    const gw = containers(t).gateway;
    expect(envOf(gw)).toMatchObject({
      BEE_API_URL: "http://127.0.0.1:1633",
      SOFT_AUTH: "true",
      POSTAGE_DEPTH: "22",
      POSTAGE_AMOUNT: "1270000000000",
      POSTAGE_KEEP_ALIVE: "true",
      POST_SIZE_LIMIT: "4mb",
      PORT: "3000",
      HOSTNAME: "swarm.example.com",
    });
    expect(secretsOf(gw).AUTH_SECRET).toContain("secret:verada/dev/bee:gatewayAuthSecret::");
    expect(gw.PortMappings).toEqual([{ ContainerPort: 3000, Protocol: "tcp" }]);
  });

  test("postage settings and image tags come from context", () => {
    const c = containers(
      Template.fromStack(
        build({ swarmPostageDepth: "20", swarmPostageAmount: "5000", swarmPostageKeepAlive: "false", beeImage: "ethersphere/bee:2.8.4" }).swarm,
      ),
    );
    expect(envOf(c.gateway)).toMatchObject({ POSTAGE_DEPTH: "20", POSTAGE_AMOUNT: "5000", POSTAGE_KEEP_ALIVE: "false" });
    expect(c.bee.Image).toBe("ethersphere/bee:2.8.4");
    expect(() => build({ swarmPostageAmount: "-1" })).toThrow(/swarmPostageAmount/);
    expect(() => build({ swarmDesiredCount: "2" })).toThrow(/swarmDesiredCount/);
  });

  test("bee API 1633: mapped, registered as bee.verada-<env>.local, ALB still targets only the gateway", () => {
    const c = containers(t);
    expect(c.bee.PortMappings).toEqual([{ ContainerPort: 1633, Protocol: "tcp", Name: "bee-api" }]);
    t.hasResourceProperties("AWS::ServiceDiscovery::PrivateDnsNamespace", { Name: "verada-dev.local" });
    t.hasResourceProperties("AWS::ServiceDiscovery::Service", {
      Name: "bee",
      DnsConfig: Match.objectLike({ DnsRecords: [{ TTL: 10, Type: "A" }] }),
    });
    t.hasResourceProperties("AWS::ECS::Service", {
      ServiceRegistries: [Match.objectLike({ RegistryArn: Match.anyValue() })],
      LoadBalancers: [Match.objectLike({ ContainerName: "gateway", ContainerPort: 3000 })],
    });
    t.hasOutput("BeeApiInternalUrl", { Value: "http://bee.verada-dev.local:1633" });
    // The Swarm stack itself opens nothing on 1633; the only rule is the publisher's (below).
    for (const r of Object.values(t.findResources("AWS::EC2::SecurityGroupIngress")) as any[]) {
      expect([r.Properties.FromPort, r.Properties.ToPort]).not.toContain(1633);
    }
    for (const r of Object.values(t.findResources("AWS::EC2::SecurityGroup")) as any[]) {
      for (const rule of r.Properties.SecurityGroupIngress ?? []) expect([rule.FromPort, rule.ToPort]).not.toContain(1633);
    }
  });

  test("bee API 1633 is reachable only from the publisher security group, never from 0.0.0.0/0", () => {
    const pt = Template.fromStack(https.publisher);
    const rules = (Object.values(pt.findResources("AWS::EC2::SecurityGroupIngress")) as any[]).filter(
      (r) => r.Properties.FromPort === 1633 || r.Properties.ToPort === 1633,
    );
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(rule.Properties).toMatchObject({ IpProtocol: "tcp", FromPort: 1633, ToPort: 1633 });
    expect(rule.Properties.CidrIp).toBeUndefined();
    expect(rule.Properties.CidrIpv6).toBeUndefined();
    const publisherSg = https.publisher.getLogicalId(
      https.publisher.service.service.connections.securityGroups[0]!.node.defaultChild as cdk.CfnElement,
    );
    expect(rule.Properties.SourceSecurityGroupId).toEqual({ "Fn::GetAtt": [publisherSg, "GroupId"] });
    // Target: the Swarm task security group, imported from the Swarm stack.
    expect(JSON.stringify(rule.Properties.GroupId)).toContain("Fn::ImportValue");
    expect(JSON.stringify(rule.Properties.GroupId)).toMatch(/Swarm/);
    // No stack anywhere admits a CIDR on 1633.
    for (const st of [https.network, https.data, https.indexer, https.swarm, https.publisher, https.obs]) {
      const tpl = Template.fromStack(st);
      const all = [
        ...(Object.values(tpl.findResources("AWS::EC2::SecurityGroupIngress")) as any[]).map((r) => r.Properties),
        ...(Object.values(tpl.findResources("AWS::EC2::SecurityGroup")) as any[]).flatMap((r) => r.Properties.SecurityGroupIngress ?? []),
      ];
      for (const r of all) {
        if (r.FromPort <= 1633 && r.ToPort >= 1633) {
          expect(r.CidrIp).toBeUndefined();
          expect(r.CidrIpv6).toBeUndefined();
        }
      }
    }
  });

  test("EFS: encrypted, backed up, IAM + TLS access point owned by the bee uid/gid, DESTROY outside prod", () => {
    t.hasResourceProperties("AWS::EFS::FileSystem", { Encrypted: true, BackupPolicy: { Status: "ENABLED" } });
    t.hasResource("AWS::EFS::FileSystem", { DeletionPolicy: "Delete" });
    t.hasResourceProperties("AWS::EFS::AccessPoint", {
      PosixUser: { Uid: "999", Gid: "999" },
      RootDirectory: { Path: "/bee", CreationInfo: { OwnerUid: "999", OwnerGid: "999", Permissions: "700" } },
    });
    t.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Volumes: [
        Match.objectLike({
          Name: "bee-data",
          EFSVolumeConfiguration: Match.objectLike({ TransitEncryption: "ENABLED", AuthorizationConfig: Match.objectLike({ IAM: "ENABLED" }) }),
        }),
      ],
    });
    t.hasResourceProperties("AWS::EC2::SecurityGroupIngress", { FromPort: 2049, ToPort: 2049 });
    const custom = Template.fromStack(build({ beeUid: "1000", beeGid: "1001" }).swarm);
    custom.hasResourceProperties("AWS::EFS::AccessPoint", { PosixUser: { Uid: "1000", Gid: "1001" } });
  });

  test("EFS is retained in prod", () => {
    Template.fromStack(build(PROD).swarm).hasResource("AWS::EFS::FileSystem", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });

  test("single task, stop-before-start deployments, no autoscaling, HTTPS + redirect, /health target check", () => {
    t.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: 1,
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 0, MaximumPercent: 100 }),
    });
    t.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 0);
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 443, Protocol: "HTTPS" });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: "redirect", RedirectConfig: Match.objectLike({ Protocol: "HTTPS", Port: "443" }) })],
    });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", { HealthCheckPath: "/health", Port: 80, TargetType: "ip" });
    t.hasOutput("GatewayUrl", { Value: "https://swarm.example.com" });
    t.resourceCountIs("AWS::S3::Bucket", 0);
  });

  test("swarmDesiredCount=0 parks the service", () => {
    Template.fromStack(build({ swarmDesiredCount: "0" }).swarm).hasResourceProperties("AWS::ECS::Service", { DesiredCount: 0 });
  });
});

describe("publisher", () => {
  const container = (t: Template) => {
    const [td] = Object.values(t.findResources("AWS::ECS::TaskDefinition")) as any[];
    return td.Properties.ContainerDefinitions[0];
  };
  const b = build({ ...HTTPS, indexerCorsOrigins: "https://verada.example", arkivEnabled: "true", publisherJobIntervalSeconds: "120" });
  const t = Template.fromStack(b.publisher);

  test("ECR repo and a 0.5 vCPU / 1 GiB single task on port 42070", () => {
    t.hasResourceProperties("AWS::ECR::Repository", {
      RepositoryName: "verada-dev-publisher",
      ImageScanningConfiguration: { ScanOnPush: true },
      ImageTagMutability: "IMMUTABLE",
    });
    t.hasResourceProperties("AWS::ECS::TaskDefinition", { Cpu: "512", Memory: "1024" });
    t.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: 1,
      LoadBalancers: [Match.objectLike({ ContainerName: "publisher", ContainerPort: 42070 })],
    });
    t.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 0);
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", { HealthCheckPath: "/health" });
    expect(container(t).HealthCheck.Command.slice(0, 2)).toEqual(["CMD", "node"]);
  });

  test("environment from context: gateway and indexer URLs, Arkiv, CORS, job interval", () => {
    const env = Object.fromEntries(container(t).Environment.map((e: any) => [e.Name, e.Value]));
    expect(env).toEqual({
      NODE_ENV: "production",
      PORT: "42070",
      BEE_GATEWAY_URL: "https://swarm.example.com",
      PUBLIC_GATEWAY_URL: "https://swarm.example.com",
      INDEXER_URL: "https://api.example.com",
      ARKIV_CHAIN: "rabdi",
      ARKIV_ENABLED: "true",
      CORS_ALLOWED_ORIGINS: "https://verada.example",
      JOB_INTERVAL_SECONDS: "120",
      BEE_STAMPS_URL: "http://bee.verada-dev.local:1633",
      CHAIN_ID: "1",
      ARKIV_DRY_RUN: "true",
      KEEPER_ENABLED: "false",
      KEEPER_DRY_RUN: "true",
      EPOCH_GOVERNOR_ADDRESS: A(4),
      FACTORY_ADDRESS: A(1),
      START_BLOCK: "1000",
      FACTORY_DEPLOY_BLOCK: "1000",
    });
  });

  test("keeper, Zama relayer, Arkiv dry run and site feed come from context; optional addresses only when set", () => {
    const c = container(
      Template.fromStack(
        build({
          keeperEnabled: "true",
          keeperDryRun: "false",
          arkivDryRun: "false",
          zamaRelayerUrl: "https://relayer.example.org/",
          votingSchemeAddress: A(10),
          takeoverGovernorAddress: A(9),
          siteFeedOwner: A(11),
          siteFeedManifest: "ab".repeat(32),
        }).publisher,
      ),
    );
    const env = Object.fromEntries(c.Environment.map((e: any) => [e.Name, e.Value]));
    expect(env).toMatchObject({
      KEEPER_ENABLED: "true",
      KEEPER_DRY_RUN: "false",
      ARKIV_DRY_RUN: "false",
      ZAMA_RELAYER_URL: "https://relayer.example.org",
      VOTING_SCHEME_ADDRESS: A(10),
      TAKEOVER_GOVERNOR_ADDRESS: A(9),
      EPOCH_GOVERNOR_ADDRESS: A(4),
      SITE_FEED_OWNER: A(11),
      SITE_FEED_MANIFEST: "ab".repeat(32),
      CHAIN_ID: "1",
    });
    // With the keeper on, the relayer API key comes from the publisher secret.
    const secrets = Object.fromEntries(c.Secrets.map((x: any) => [x.Name, JSON.stringify(x.ValueFrom)]));
    expect(secrets.ZAMA_RELAYER_API_KEY).toContain("secret:verada/dev/publisher:zamaRelayerApiKey::");
    // Defaults: no zero-address placeholders, no relayer URL, no site feed.
    const d = Object.fromEntries(container(t).Environment.map((e: any) => [e.Name, e.Value]));
    for (const k of ["VOTING_SCHEME_ADDRESS", "TAKEOVER_GOVERNOR_ADDRESS", "ZAMA_RELAYER_URL", "SITE_FEED_OWNER", "SITE_FEED_MANIFEST"]) {
      expect(d).not.toHaveProperty(k);
    }
    expect(() => build({ keeperEnabled: "true" })).toThrow(/keeperEnabled.*votingSchemeAddress/);
    expect(() => build({ keeperDryRun: "maybe" })).toThrow(/keeperDryRun/);
    expect(() => build({ zamaRelayerUrl: "ftp://x" })).toThrow(/zamaRelayerUrl/);
    expect(() => build({ ...PROD, zamaRelayerUrl: "http://relayer.example.org" })).toThrow(/https "zamaRelayerUrl"/);
    expect(() => build({ siteFeedOwner: "0x12" })).toThrow(/siteFeedOwner/);
    expect(() => build({ siteFeedManifest: "zz" })).toThrow(/siteFeedManifest/);
    expect(() => build({ publisherJobIntervalSeconds: "86401" })).toThrow(/publisherJobIntervalSeconds/);
  });

  test("overrides: indexerPublicUrl, swarmGatewayUrl, publisherCorsOrigins, arkivChain", () => {
    const c = container(
      Template.fromStack(
        build({
          indexerPublicUrl: "https://idx.example.org/",
          swarmGatewayUrl: "https://gw.example.org",
          publisherCorsOrigins: "https://app.example.org",
          arkivChain: "kaolin",
        }).publisher,
      ),
    );
    const env = Object.fromEntries(c.Environment.map((e: any) => [e.Name, e.Value]));
    expect(env).toMatchObject({
      INDEXER_URL: "https://idx.example.org",
      BEE_GATEWAY_URL: "https://gw.example.org",
      CORS_ALLOWED_ORIGINS: "https://app.example.org",
      ARKIV_CHAIN: "kaolin",
      ARKIV_ENABLED: "false",
    });
    expect(() => build({ publisherCorsOrigins: "https://a.example/" })).toThrow(/publisherCorsOrigins/);
    expect(() => build({ indexerPublicUrl: "ftp://x" })).toThrow(/indexerPublicUrl/);
  });

  test("every secret comes from the verada/<env>/publisher JSON fields", () => {
    const secrets = Object.fromEntries(container(t).Secrets.map((x: any) => [x.Name, JSON.stringify(x.ValueFrom)]));
    const expected: Record<string, string> = {
      BEE_GATEWAY_AUTH_SECRET: "beeGatewayAuthSecret",
      SWARM_BATCH_ID: "swarmBatchId",
      ARKIV_ACCESS_KEY: "arkivAccessKey",
      ARKIV_PRIVATE_KEY: "arkivPrivateKey",
      KEEPER_PRIVATE_KEY: "keeperPrivateKey",
      ETH_RPC_URL: "ethRpcUrl",
    };
    expect(Object.keys(secrets).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, field] of Object.entries(expected)) expect(secrets[name]).toContain(`secret:verada/dev/publisher:${field}::`);
    const env = JSON.stringify(container(t).Environment);
    expect(env).not.toMatch(/PRIVATE_KEY|AUTH_SECRET|BATCH_ID|ETH_RPC_URL/);
  });

  test("HTTPS listener with redirect; dev insecure mode is HTTP only and warns about missing URLs", () => {
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 443, Protocol: "HTTPS" });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: "redirect" })],
    });
    const d = build();
    Template.fromStack(d.publisher).resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 1);
    Annotations.fromStack(d.publisher).hasWarning("*", Match.stringLikeRegexp("No Swarm gateway URL"));
    expect(() => build({ publisherDesiredCount: "2" })).toThrow(/publisherDesiredCount/);
  });

  test("hosted zone mode creates the certificate and alias record", () => {
    const z = build({
      ...HTTPS,
      publisherCertificateArn: "",
      publisherHostedZoneId: "Z0000000000000",
      publisherHostedZoneName: "example.com",
    });
    const zt = Template.fromStack(z.publisher);
    zt.hasResourceProperties("AWS::CertificateManager::Certificate", { DomainName: "publisher.example.com" });
    zt.hasResourceProperties("AWS::Route53::RecordSet", { Name: "publisher.example.com.", Type: "A" });
  });
});

describe("service alarms", () => {
  test("publisher log alarms: postage batch warning and tally keeper errors, on the shared topic", () => {
    const b = build();
    const t = Template.fromStack(b.obs);
    const topic = b.obs.getLogicalId(b.obs.alarmTopic.node.defaultChild as cdk.CfnElement);
    t.hasResourceProperties("AWS::Logs::MetricFilter", {
      FilterPattern: '{ ($.level = "warn") && ($.msg = "postage batch needs attention") }',
      MetricTransformations: [Match.objectLike({ MetricName: "PostageBatchAttention", MetricValue: "1", MetricNamespace: "Verada/dev/Publisher" })],
    });
    t.hasResourceProperties("AWS::Logs::MetricFilter", {
      FilterPattern: Match.stringLikeRegexp('^\\{ \\(\\$\\.level = "error"\\) && .*"keeper\\*".*"tally keeper\\*".*"job tally-keeper\\*"'),
      MetricTransformations: [Match.objectLike({ MetricName: "TallyKeeperErrors" })],
    });
    // Both filters read the publisher log group (imported from the Publisher stack).
    for (const f of Object.values(t.findResources("AWS::Logs::MetricFilter")) as any[]) {
      expect(JSON.stringify(f.Properties.LogGroupName)).toMatch(/ImportValue.*Publisher/);
    }
    for (const [metric, period] of [
      ["PostageBatchAttention", 1200],
      ["TallyKeeperErrors", 300],
    ] as const) {
      t.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: metric,
        Namespace: "Verada/dev/Publisher",
        Statistic: "Sum",
        Period: period,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
        AlarmActions: [{ Ref: topic }],
        OKActions: [{ Ref: topic }],
      });
    }
  });

  test("the postage alarm window covers two stamp-watch runs", () => {
    const t = Template.fromStack(build({ publisherJobIntervalSeconds: "3600" }).obs);
    t.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "PostageBatchAttention", Period: 7200 });
    t.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "TallyKeeperErrors", Period: 3600 });
  });

  test("swarm and publisher get unhealthy-target and no-running-task alarms on the shared topic", () => {
    const t = Template.fromStack(build().obs);
    for (const label of ["Swarm gateway", "Publisher"]) {
      t.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmDescription: `${label} has unhealthy targets behind the ALB`,
        AlarmActions: [Match.anyValue()],
      });
      t.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmDescription: `${label} has no running task`,
        Namespace: "ECS/ContainerInsights",
        MetricName: "RunningTaskCount",
        ComparisonOperator: "LessThanThreshold",
        Threshold: 1,
        TreatMissingData: "breaching",
      });
    }
  });
});
