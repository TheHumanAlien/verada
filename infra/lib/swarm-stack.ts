import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as efs from "aws-cdk-lib/aws-efs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import { Construct } from "constructs";
import { resolveTls } from "./alb-tls";
import { BEE_SECRET_FIELDS, VeradaConfig } from "./config";

export interface SwarmStackProps extends cdk.StackProps {
  readonly config: VeradaConfig;
  readonly vpc: ec2.IVpc;
}

export const GATEWAY_PORT = 3000;
export const GATEWAY_HEALTH_PATH = "/health";
export const BEE_API_PORT = 1633;
export const BEE_DATA_DIR = "/home/bee/.bee";
/** Cloud Map service name of the Bee API inside the private namespace. */
export const BEE_SERVICE_NAME = "bee";

/** Private DNS namespace (a Route53 private zone on the VPC) the Swarm task registers in. */
export const beeNamespaceName = (envName: string): string => `verada-${envName}.local`;

/** Bee API as reachable from inside the VPC: a stable private DNS name and the task security group. */
export interface BeeApiEndpoint {
  /** e.g. bee.verada-dev.local */
  readonly hostname: string;
  readonly port: number;
  /** http://<hostname>:<port> (plain HTTP inside the VPC; Bee has no TLS listener). */
  readonly url: string;
  /** The Swarm task's security group; callers open 1633 to themselves with allowTo(). */
  readonly connections: ec2.Connections;
}

/**
 * One Bee light node plus the Swarm gateway (ethersphere/swarm-gateway) in a single Fargate task.
 * The gateway is the only thing behind the public ALB. Bee's API binds every task interface: the
 * gateway reaches it over loopback (containers in an awsvpc task share one network namespace), and
 * the publisher reaches it at bee.verada-<env>.local:1633 (Cloud Map A record) for postage batch
 * status, which the gateway does not proxy. The task security group admits 1633 from the publisher's
 * security group only (that rule lives in the Publisher stack); nothing public reaches it.
 * Bee's data directory (node key, chequebook state, local store) lives on EFS, so there is exactly
 * one task and no autoscaling: two Bee processes must never open the same data directory.
 */
export class SwarmStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly fileSystem: efs.FileSystem;
  public readonly accessPoint: efs.AccessPoint;
  public readonly service: ecsPatterns.ApplicationLoadBalancedFargateService;
  /** Base URL clients use (https://<swarmDomainName>, or the ALB name over HTTP in throwaway envs). */
  public readonly gatewayUrl: string;
  public readonly namespace: servicediscovery.PrivateDnsNamespace;
  public readonly beeApi: BeeApiEndpoint;

  constructor(scope: Construct, id: string, props: SwarmStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;
    const sw = config.swarm;

    this.cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsights: true });

    this.fileSystem = new efs.FileSystem(this, "BeeData", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      // Pay per use: a small bursting file system would have almost no baseline throughput.
      throughputMode: efs.ThroughputMode.ELASTIC,
      // The Bee node key and chequebook live here: AWS Backup daily plan, and never deleted in prod.
      enableAutomaticBackups: true,
      removalPolicy: config.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      allowAnonymousAccess: false,
    });
    this.fileSystem.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "DenyInsecureTransport",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["*"],
        conditions: { Bool: { "aws:SecureTransport": "false" } },
      }),
    );
    this.accessPoint = this.fileSystem.addAccessPoint("BeeAccessPoint", {
      path: "/bee",
      createAcl: { ownerUid: String(sw.beeUid), ownerGid: String(sw.beeGid), permissions: "700" },
      posixUser: { uid: String(sw.beeUid), gid: String(sw.beeGid) },
    });

    const secret = secretsmanager.Secret.fromSecretNameV2(this, "BeeSecret", sw.secretName);
    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: config.isProd ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, "Task", {
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      volumes: [
        {
          name: "bee-data",
          efsVolumeConfiguration: {
            fileSystemId: this.fileSystem.fileSystemId,
            transitEncryption: "ENABLED",
            authorizationConfig: { accessPointId: this.accessPoint.accessPointId, iam: "ENABLED" },
          },
        },
      ],
    });
    this.fileSystem.grant(taskDefinition.taskRole, "elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite");

    // Added first so it is the task's default container: the ALB pattern targets it.
    const gateway = taskDefinition.addContainer("gateway", {
      image: ecs.ContainerImage.fromRegistry(sw.gatewayImage),
      portMappings: [{ containerPort: GATEWAY_PORT, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "gateway", logGroup }),
      environment: {
        PORT: String(GATEWAY_PORT),
        // Loopback inside the task; never the private DNS name, so the gateway does not depend on Cloud Map.
        BEE_API_URL: `http://127.0.0.1:${BEE_API_PORT}`,
        // Subdomain routing base; set explicitly so the container's own HOSTNAME never leaks in.
        HOSTNAME: sw.domainName ?? "localhost",
        // Reads are open; every POST (uploads, feed updates) needs AUTH_SECRET in Authorization.
        SOFT_AUTH: "true",
        POSTAGE_DEPTH: String(sw.postageDepth),
        POSTAGE_AMOUNT: sw.postageAmount,
        POSTAGE_KEEP_ALIVE: String(sw.postageKeepAlive),
        POST_SIZE_LIMIT: "4mb",
      },
      secrets: {
        AUTH_SECRET: ecs.Secret.fromSecretsManager(secret, BEE_SECRET_FIELDS.AUTH_SECRET),
      },
      // node:*-slim image: no wget/curl, so probe with node's fetch.
      healthCheck: {
        command: [
          "CMD",
          "node",
          "-e",
          `fetch('http://127.0.0.1:${GATEWAY_PORT}${GATEWAY_HEALTH_PATH}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    const bee = taskDefinition.addContainer("bee", {
      image: ecs.ContainerImage.fromRegistry(sw.beeImage),
      command: ["start"],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "bee", logGroup }),
      // Let Bee flush its local store on stop (Fargate maximum).
      stopTimeout: cdk.Duration.seconds(120),
      // Mapped (and bound on all interfaces) so the publisher can read GET /stamps/{batchId}; only the
      // publisher's security group may connect. The gateway keeps using 127.0.0.1.
      portMappings: [{ containerPort: BEE_API_PORT, protocol: ecs.Protocol.TCP, name: "bee-api" }],
      environment: {
        BEE_API_ADDR: `:${BEE_API_PORT}`,
        BEE_DATA_DIR,
        BEE_FULL_NODE: "false",
        BEE_SWAP_ENABLE: "true",
        BEE_MAINNET: "true",
      },
      secrets: {
        BEE_PASSWORD: ecs.Secret.fromSecretsManager(secret, BEE_SECRET_FIELDS.BEE_PASSWORD),
        BEE_BLOCKCHAIN_RPC_ENDPOINT: ecs.Secret.fromSecretsManager(secret, BEE_SECRET_FIELDS.BEE_BLOCKCHAIN_RPC_ENDPOINT),
      },
      // The Bee image is debian-slim with only ca-certificates added (no wget/curl), so use bash's
      // /dev/tcp to issue GET /health and require a 200 status line.
      healthCheck: {
        command: [
          "CMD",
          "bash",
          "-c",
          `exec 3<>/dev/tcp/127.0.0.1/${BEE_API_PORT} && printf 'GET /health HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && head -n1 <&3 | grep -q ' 200 '`,
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 5,
        // ECS maximum; first boot also waits for the wallet to be funded (README operator checklist).
        startPeriod: cdk.Duration.seconds(300),
      },
    });
    bee.addMountPoints({ sourceVolume: "bee-data", containerPath: BEE_DATA_DIR, readOnly: false });
    gateway.addContainerDependencies({ container: bee, condition: ecs.ContainerDependencyCondition.HEALTHY });

    this.namespace = new servicediscovery.PrivateDnsNamespace(this, "Namespace", {
      name: beeNamespaceName(config.envName),
      vpc,
      description: `Verada ${config.envName} internal service names`,
    });

    const https = sw.httpsEnabled;
    const { zone, certificate } = resolveTls(this, sw);
    this.service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Service", {
      cluster: this.cluster,
      taskDefinition,
      // The pattern rejects 0; the real value (0 or 1) is applied below.
      desiredCount: 1,
      taskSubnets: { subnetType: config.privateEgress ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PUBLIC },
      assignPublicIp: !config.privateEgress,
      publicLoadBalancer: true,
      protocol: https ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      certificate,
      domainName: zone ? sw.domainName : undefined,
      domainZone: zone,
      redirectHTTP: https,
      circuitBreaker: { enable: true, rollback: true },
      // Stop the old task before starting the new one: the EFS data directory is single-writer.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      // Bee start-up (up to its 300 s health start period) plus the gateway's.
      healthCheckGracePeriod: cdk.Duration.seconds(600),
      // A record for the task IP (awsvpc). Short TTL: each deploy replaces the single task and its IP.
      cloudMapOptions: {
        name: BEE_SERVICE_NAME,
        cloudMapNamespace: this.namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });
    // No ALB access logs: they would record client IPs and the content they fetch (docs/PRIVACY.md).
    this.service.loadBalancer.setAttribute("routing.http.drop_invalid_header_fields.enabled", "true");
    this.service.targetGroup.configureHealthCheck({
      path: GATEWAY_HEALTH_PATH,
      healthyHttpCodes: "200",
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(10),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });
    this.service.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "30");

    this.fileSystem.connections.allowDefaultPortFrom(this.service.service, "Bee task to its EFS data directory");

    if (sw.desiredCount === 0) {
      (this.service.service.node.defaultChild as ecs.CfnService).desiredCount = 0;
    }

    const beeHost = `${BEE_SERVICE_NAME}.${beeNamespaceName(config.envName)}`;
    this.beeApi = {
      hostname: beeHost,
      port: BEE_API_PORT,
      url: `http://${beeHost}:${BEE_API_PORT}`,
      connections: this.service.service.connections,
    };

    const host = sw.domainName ?? this.service.loadBalancer.loadBalancerDnsName;
    this.gatewayUrl = `${https ? "https" : "http"}://${host}`;
    new cdk.CfnOutput(this, "GatewayUrl", { value: this.gatewayUrl });
    new cdk.CfnOutput(this, "LoadBalancerDnsName", { value: this.service.loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, "BeeFileSystemId", { value: this.fileSystem.fileSystemId });
    new cdk.CfnOutput(this, "BeeApiInternalUrl", { value: this.beeApi.url });
  }
}
