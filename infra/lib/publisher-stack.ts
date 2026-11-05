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
import { PUBLISHER_SECRET_FIELDS, VeradaConfig } from "./config";

export interface PublisherStackProps extends cdk.StackProps {
  readonly config: VeradaConfig;
  readonly vpc: ec2.IVpc;
}

export const PUBLISHER_PORT = 42070;
export const PUBLISHER_HEALTH_PATH = "/health";

/**
 * services/publisher on Fargate behind a public HTTPS ALB. It uploads site content and feed updates
 * through the Swarm gateway (by URL from context, so there is no stack dependency on SwarmStack).
 */
export class PublisherStack extends cdk.Stack {
  public readonly repository: ecr.Repository;
  public readonly cluster: ecs.Cluster;
  public readonly service: ecsPatterns.ApplicationLoadBalancedFargateService;

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
    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: config.isProd ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const environment: Record<string, string> = {
      NODE_ENV: "production",
      PORT: String(PUBLISHER_PORT),
      ARKIV_CHAIN: pub.arkivChain,
      ARKIV_ENABLED: String(pub.arkivEnabled),
      JOB_INTERVAL_SECONDS: String(pub.jobIntervalSeconds),
    };
    if (pub.gatewayUrl) {
      environment.BEE_GATEWAY_URL = pub.gatewayUrl;
      environment.PUBLIC_GATEWAY_URL = pub.gatewayUrl;
    }
    if (pub.indexerUrl) environment.INDEXER_URL = pub.indexerUrl;
    if (pub.corsOrigins) environment.CORS_ALLOWED_ORIGINS = pub.corsOrigins;

    const secrets = Object.fromEntries(
      Object.entries(PUBLISHER_SECRET_FIELDS).map(([envVar, field]) => [envVar, ecs.Secret.fromSecretsManager(secret, field)]),
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

    if (pub.desiredCount === 0) {
      (this.service.service.node.defaultChild as ecs.CfnService).desiredCount = 0;
    }

    new cdk.CfnOutput(this, "RepositoryUri", { value: this.repository.repositoryUri });
    const host = pub.domainName ?? this.service.loadBalancer.loadBalancerDnsName;
    new cdk.CfnOutput(this, "PublisherUrl", { value: `${https ? "https" : "http"}://${host}` });
    new cdk.CfnOutput(this, "LoadBalancerDnsName", { value: this.service.loadBalancer.loadBalancerDnsName });
  }
}
