import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { resolveTls } from "./alb-tls";
import {
  CHAIN_ID,
  PUBLISHER_CHAIN_ENV,
  PUBLISHER_FACILITATOR_SECRET_FIELDS,
  PUBLISHER_KEEPER_SECRET_FIELDS,
  PUBLISHER_SECRET_FIELDS,
  VeradaConfig,
  ZERO_ADDRESS,
} from "./config";
import type { LogAlarmSpec } from "./observability-stack";
import type { BeeApiEndpoint } from "./swarm-stack";

export interface PublisherStackProps extends cdk.StackProps {
  readonly config: VeradaConfig;
  readonly vpc: ec2.IVpc;
  /** Bee API inside the VPC (SwarmStack.beeApi): BEE_STAMPS_URL and the 1633 ingress rule. */
  readonly bee?: BeeApiEndpoint;
}

export const PUBLISHER_PORT = 42070;
export const PUBLISHER_HEALTH_PATH = "/health";

/** stamp-watch runs every max(JOB_INTERVAL_SECONDS, 600 s) (services/publisher/src/index.ts). */
export const STAMP_WATCH_MIN_SECONDS = 600;

/**
 * Log lines the alarms match. The publisher logs one JSON object per line: {"level","msg",...}.
 * stamp-watch: level "warn", msg "postage batch needs attention".
 * Tally keeper: level "error" with a msg prefixed "keeper" or "tally keeper" (services/publisher/src/keeper,
 * src/jobs/tally-keeper.ts), or the job runner's "job tally-keeper failed" when a run throws.
 */
export const POSTAGE_ATTENTION_PATTERN = logs.FilterPattern.all(
  logs.FilterPattern.stringValue("$.level", "=", "warn"),
  logs.FilterPattern.stringValue("$.msg", "=", "postage batch needs attention"),
);
export const TALLY_KEEPER_ERROR_PATTERN = logs.FilterPattern.all(
  logs.FilterPattern.stringValue("$.level", "=", "error"),
  logs.FilterPattern.any(
    logs.FilterPattern.stringValue("$.msg", "=", "keeper*"),
    logs.FilterPattern.stringValue("$.msg", "=", "tally keeper*"),
    logs.FilterPattern.stringValue("$.msg", "=", "job tally-keeper*"),
  ),
);

/**
 * services/publisher on Fargate behind a public HTTPS ALB. It uploads site content and feed updates
 * through the Swarm gateway (by URL from context). It reads postage batch status straight from the
 * Bee API at its private DNS name; the one cross-stack reference is the Swarm task security group,
 * which gets an ingress rule on 1633 from this service's security group (the rule lives here).
 */
export class PublisherStack extends cdk.Stack {
  public readonly repository: ecr.Repository;
  public readonly cluster: ecs.Cluster;
  public readonly service: ecsPatterns.ApplicationLoadBalancedFargateService;
  public readonly logGroup: logs.LogGroup;
  /** Log-pattern alarms the Observability stack wires to the alarm topic. */
  public readonly logAlarms: LogAlarmSpec[];

  constructor(scope: Construct, id: string, props: PublisherStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;
    const pub = config.publisher;
    if (!pub.gatewayUrl) {
      cdk.Annotations.of(this).addWarning(
        "No Swarm gateway URL (swarmDomainName or swarmGatewayUrl): BEE_GATEWAY_URL and PUBLIC_GATEWAY_URL are not set.",
      );
    }
    if (!pub.indexerUrl) {
      cdk.Annotations.of(this).addWarning("No indexer URL (indexerPublicUrl or an HTTPS indexerDomainName): INDEXER_URL is not set.");
    }

    this.repository = new ecr.Repository(this, "Repo", {
      repositoryName: `verada-${config.envName}-publisher`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy: config.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: !config.isProd,
      lifecycleRules: [{ maxImageCount: 30, description: "keep the 30 most recent images" }],
    });

    this.cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsights: true });

    const secret = secretsmanager.Secret.fromSecretNameV2(this, "PublisherSecret", pub.secretName);
    if (!props.bee) {
      cdk.Annotations.of(this).addWarning("No Bee API endpoint: BEE_STAMPS_URL is not set and postage batch status falls back to the gateway.");
    }
    const logGroup = (this.logGroup = new logs.LogGroup(this, "Logs", {
      retention: config.isProd ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }));

    const environment: Record<string, string> = {
      NODE_ENV: "production",
      PORT: String(PUBLISHER_PORT),
      ARKIV_CHAIN: pub.arkivChain,
      ARKIV_ENABLED: String(pub.arkivEnabled),
      JOB_INTERVAL_SECONDS: String(pub.jobIntervalSeconds),
      CHAIN_ID: String(CHAIN_ID),
      ARKIV_DRY_RUN: String(pub.arkivDryRun),
      KEEPER_ENABLED: String(pub.keeperEnabled),
      KEEPER_DRY_RUN: String(pub.keeperDryRun),
      X402_FACILITATOR_ENABLED: String(pub.facilitator.enabled),
    };
    // Same values the indexer gets; optional addresses left at the zero address are omitted, so the
    // service sees "not configured" rather than a call target of 0x0.
    for (const name of PUBLISHER_CHAIN_ENV) {
      const v = config.indexerChain[name];
      if (v && v !== ZERO_ADDRESS) environment[name] = v;
    }
    // The keeper's factory log fallback reads FACTORY_DEPLOY_BLOCK; it is the same deployment block.
    if (environment.START_BLOCK) environment.FACTORY_DEPLOY_BLOCK = environment.START_BLOCK;
    if (props.bee) environment.BEE_STAMPS_URL = props.bee.url;
    if (pub.zamaRelayerUrl) environment.ZAMA_RELAYER_URL = pub.zamaRelayerUrl;
    if (pub.siteFeedOwner) environment.SITE_FEED_OWNER = pub.siteFeedOwner;
    if (pub.siteFeedManifest) environment.SITE_FEED_MANIFEST = pub.siteFeedManifest;
    if (pub.gatewayUrl) {
      environment.BEE_GATEWAY_URL = pub.gatewayUrl;
      environment.PUBLIC_GATEWAY_URL = pub.gatewayUrl;
    }
    if (pub.indexerUrl) environment.INDEXER_URL = pub.indexerUrl;
    if (pub.corsOrigins) environment.CORS_ALLOWED_ORIGINS = pub.corsOrigins;
    if (pub.maxReportBytes !== undefined) environment.MAX_REPORT_BYTES = String(pub.maxReportBytes);
    const f = pub.facilitator;
    if (f.enabled) {
      if (f.payTo) environment.X402_FACILITATOR_PAY_TO = f.payTo;
      if (f.network) environment.X402_FACILITATOR_NETWORK = f.network;
      if (f.usdc) environment.X402_FACILITATOR_USDC = f.usdc;
      if (f.oneClawBaseUrl) environment.ONECLAW_BASE_URL = f.oneClawBaseUrl;
    }

    // The relayer API key and facilitator fields are referenced only when their feature is on, so
    // existing secrets keep working.
    const fields: Record<string, string> = {
      ...PUBLISHER_SECRET_FIELDS,
      ...(pub.keeperEnabled ? PUBLISHER_KEEPER_SECRET_FIELDS : {}),
      ...(f.enabled ? PUBLISHER_FACILITATOR_SECRET_FIELDS : {}),
    };
    const secrets = Object.fromEntries(
      Object.entries(fields).map(([envVar, field]) => [envVar, ecs.Secret.fromSecretsManager(secret, field)]),
    );

    const https = pub.httpsEnabled;
    const { zone, certificate } = resolveTls(this, pub);
    this.service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Service", {
      cluster: this.cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      // The pattern rejects 0; the real value (including 0 for a first deploy) is applied below.
      desiredCount: Math.max(1, pub.desiredCount),
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskSubnets: { subnetType: config.privateEgress ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PUBLIC },
      assignPublicIp: !config.privateEgress,
      publicLoadBalancer: true,
      protocol: https ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      certificate,
      domainName: zone ? pub.domainName : undefined,
      domainZone: zone,
      redirectHTTP: https,
      circuitBreaker: { enable: true, rollback: true },
      // The publisher signs keeper transactions; one task at a time avoids nonce races during deploys.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(this.repository, pub.imageTag),
        containerName: "publisher",
        containerPort: PUBLISHER_PORT,
        enableLogging: true,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: "publisher", logGroup }),
        environment,
        secrets,
      },
    });
    // No ALB access logs, by design (docs/PRIVACY.md).
    this.service.loadBalancer.setAttribute("routing.http.drop_invalid_header_fields.enabled", "true");
    this.service.targetGroup.configureHealthCheck({
      path: PUBLISHER_HEALTH_PATH,
      healthyHttpCodes: "200",
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(10),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });
    this.service.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "30");

    const cfnTask = this.service.taskDefinition.node.defaultChild as ecs.CfnTaskDefinition;
    cfnTask.addPropertyOverride("ContainerDefinitions.0.HealthCheck", {
      Command: [
        "CMD",
        "node",
        "-e",
        `fetch('http://127.0.0.1:${PUBLISHER_PORT}${PUBLISHER_HEALTH_PATH}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
      ],
      Interval: 30,
      Timeout: 5,
      Retries: 3,
      StartPeriod: 30,
    });

    if (props.bee) {
      // Ingress on the Swarm task security group, sourced from this service's group only. allowTo puts
      // the rule in this stack, so the Swarm stack never references the publisher (no cycle).
      this.service.service.connections.allowTo(
        props.bee.connections,
        ec2.Port.tcp(props.bee.port),
        "Publisher reads postage batch status from the Bee API",
      );
    }

    const stampWatchSeconds = Math.max(pub.jobIntervalSeconds, STAMP_WATCH_MIN_SECONDS);
    this.logAlarms = [
      {
        id: "PostageBatchAttention",
        description:
          "Publisher: postage batch needs attention (unusable, TTL under 30 days or utilization over 70%); top up, dilute or replace it. Details in the publisher log.",
        logGroup,
        filterPattern: POSTAGE_ATTENTION_PATTERN,
        // Two stamp-watch runs, so the alarm does not flap between runs (CloudWatch maximum: 1 day).
        period: cdk.Duration.minutes(Math.min(1440, Math.ceil((2 * stampWatchSeconds) / 60))),
      },
      {
        id: "TallyKeeperErrors",
        description: "Publisher: the tally keeper logged an error. Check the publisher log (stream prefix publisher).",
        logGroup,
        filterPattern: TALLY_KEEPER_ERROR_PATTERN,
        period: cdk.Duration.minutes(Math.max(5, Math.min(1440, Math.ceil(pub.jobIntervalSeconds / 60)))),
      },
    ];

    if (pub.desiredCount === 0) {
      (this.service.service.node.defaultChild as ecs.CfnService).desiredCount = 0;
    }

    new cdk.CfnOutput(this, "RepositoryUri", { value: this.repository.repositoryUri });
    const host = pub.domainName ?? this.service.loadBalancer.loadBalancerDnsName;
    new cdk.CfnOutput(this, "PublisherUrl", { value: `${https ? "https" : "http"}://${host}` });
    new cdk.CfnOutput(this, "LoadBalancerDnsName", { value: this.service.loadBalancer.loadBalancerDnsName });
  }
}
