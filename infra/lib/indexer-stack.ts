import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { VeradaConfig } from "./config";

export interface IndexerStackProps extends cdk.StackProps {
  readonly config: VeradaConfig;
  readonly vpc: ec2.IVpc;
  readonly dbSecret: secretsmanager.ISecret;
  readonly dbSecurityGroup: ec2.ISecurityGroup;
  readonly dbName: string;
}

export const INDEXER_PORT = 42069;
export const INDEXER_HEALTH_PATH = "/health";
/** Header CloudFront adds to every origin request; the ALB forwards only requests that carry it. */
export const INDEXER_ORIGIN_HEADER = "X-Verada-Origin";

export class IndexerStack extends cdk.Stack {
  public readonly repository: ecr.Repository;
  public readonly cluster: ecs.Cluster;
  public readonly service: ecsPatterns.ApplicationLoadBalancedFargateService;
  /** Present when the API is served through CloudFront's default HTTPS domain (no custom domain). */
  public readonly distribution?: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: IndexerStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;
    if (!config.indexerChain.START_BLOCK) {
      cdk.Annotations.of(this).addWarning(
        "No indexer chain context (startBlock and contract addresses): tasks will exit at start-up. Deploy with indexerDesiredCount=0 until they are known.",
      );
    } else if (config.indexerChainMissing.length > 0) {
      cdk.Annotations.of(this).addWarning(
        `Missing indexer context ${config.indexerChainMissing.join(", ")}: tasks will exit at start-up until it is passed.`,
      );
    }

    this.repository = new ecr.Repository(this, "Repo", {
      repositoryName: `verada-${config.envName}-indexer`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy: config.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: !config.isProd,
      lifecycleRules: [{ maxImageCount: 30, description: "keep the 30 most recent images" }],
    });

    this.cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsights: true });

    const rpcSecret = secretsmanager.Secret.fromSecretNameV2(this, "RpcSecret", config.rpcSecretName);
    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: config.isProd ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const https = config.httpsEnabled;
    // Without a custom domain, CloudFront's default *.cloudfront.net certificate gives browsers HTTPS
    // while the ALB stays HTTP behind it. Opt in with -c indexerCloudFront=true (needs allowInsecureHttp).
    const ctxFlag = this.node.tryGetContext("indexerCloudFront");
    const edge = !https && (ctxFlag === true || ctxFlag === "true");
    const edgePrefixList: string | undefined = this.node.tryGetContext("indexerCloudFrontPrefixListId") || undefined;
    if (edgePrefixList && !/^pl-[0-9a-f]+$/.test(edgePrefixList)) {
      throw new Error('context "indexerCloudFrontPrefixListId" must be a managed prefix list id like pl-0123abcd');
    }
    const zone = config.indexerHostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
          hostedZoneId: config.indexerHostedZoneId,
          zoneName: config.indexerHostedZoneName!,
        })
      : undefined;
    let certificate: acm.ICertificate | undefined;
    if (config.indexerCertificateArn) {
      certificate = acm.Certificate.fromCertificateArn(this, "Cert", config.indexerCertificateArn);
    } else if (zone) {
      certificate = new acm.Certificate(this, "Cert", {
        domainName: config.indexerDomainName!,
        validation: acm.CertificateValidation.fromDns(zone),
      });
    }
    this.service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Service", {
      cluster: this.cluster,
      cpu: 1024,
      memoryLimitMiB: 2048,
      // The pattern rejects 0; the real value (including 0 for a first deploy) is applied below.
      desiredCount: Math.max(1, config.indexerDesiredCount),
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      // Default: public subnets + public IP (no NAT), reachable only through the ALB because the task
      // security group admits nothing else. privateEgress moves tasks to private subnets without a public IP.
      taskSubnets: { subnetType: config.privateEgress ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PUBLIC },
      assignPublicIp: !config.privateEgress,
      publicLoadBalancer: true,
      // Behind CloudFront with a known origin-facing prefix list, only CloudFront may reach the listener.
      openListener: !(edge && edgePrefixList),
      protocol: https ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      certificate,
      domainName: zone ? config.indexerDomainName : undefined,
      domainZone: zone,
      redirectHTTP: https,
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: cdk.Duration.seconds(120),
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(this.repository, config.indexerImageTag),
        containerName: "indexer",
        containerPort: INDEXER_PORT,
        // Ponder only talks to Postgres when DATABASE_URL is set (otherwise it silently uses embedded
        // PGlite). ECS cannot compose a URL from secret fields, so build it at start-up from the injected
        // parts (so credential rotation is picked up on the next task start) and refuse to start if any
        // part is missing. sslmode=no-verify: the RDS CA is not in the Node trust store; traffic stays
        // inside isolated subnets.
        command: [
          "sh",
          "-c",
          [
            ': "${DATABASE_HOST:?}" "${DATABASE_PORT:?}" "${DATABASE_USER:?}" "${DATABASE_PASSWORD:?}" "${DATABASE_NAME:?}"',
            "enc() { node -p 'encodeURIComponent(process.env[process.argv[1]])' \"$1\"; }",
            'export DATABASE_URL="postgresql://$(enc DATABASE_USER):$(enc DATABASE_PASSWORD)@${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}?sslmode=no-verify"',
            'exec node_modules/.bin/ponder start',
          ].join("; "),
        ],
        enableLogging: true,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: "indexer", logGroup }),
        environment: {
          NODE_ENV: "production",
          PORT: String(INDEXER_PORT),
          DATABASE_NAME: props.dbName,
          DATABASE_SCHEMA: "verada",
          ...(config.indexerCorsOrigins ? { CORS_ALLOWED_ORIGINS: config.indexerCorsOrigins } : {}),
          ...(config.indexerCatalogSource ? { CATALOG_SOURCE: config.indexerCatalogSource } : {}),
          // START_BLOCK, the contract addresses the indexer requires, and the optional ones (zero address
          // when not given). All validated in config.ts.
          ...config.indexerChain,
        },
        secrets: {
          DATABASE_HOST: ecs.Secret.fromSecretsManager(props.dbSecret, "host"),
          DATABASE_PORT: ecs.Secret.fromSecretsManager(props.dbSecret, "port"),
          DATABASE_USER: ecs.Secret.fromSecretsManager(props.dbSecret, "username"),
          DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(props.dbSecret, "password"),
          ETH_RPC_URL: ecs.Secret.fromSecretsManager(rpcSecret),
        },
      },
    });
    // No ALB access logs, by design: they would store every client IP and request path.
    // Verada must not be able to tie users to what they look at (docs/PRIVACY.md).
    this.service.loadBalancer.setAttribute("routing.http.drop_invalid_header_fields.enabled", "true");

    this.service.targetGroup.configureHealthCheck({
      path: INDEXER_HEALTH_PATH,
      healthyHttpCodes: "200",
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(10),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });
    this.service.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "30");

    // Container-level health check hits the same endpoint. The image is node:22-slim (no wget/curl),
    // so use node, mirroring the Dockerfile HEALTHCHECK.
    const cfnTask = this.service.taskDefinition.node.defaultChild as ecs.CfnTaskDefinition;
    cfnTask.addPropertyOverride("ContainerDefinitions.0.HealthCheck", {
      Command: [
        "CMD",
        "node",
        "-e",
        `fetch('http://127.0.0.1:${INDEXER_PORT}${INDEXER_HEALTH_PATH}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
      ],
      Interval: 30,
      Timeout: 5,
      Retries: 3,
      StartPeriod: 60,
    });

    // Database ingress is declared here (not on the DB security group object) so the
    // dependency stays Indexer -> Data and no stack cycle forms.
    new ec2.CfnSecurityGroupIngress(this, "DbIngressFromIndexer", {
      groupId: props.dbSecurityGroup.securityGroupId,
      sourceSecurityGroupId: this.service.service.connections.securityGroups[0]!.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      description: "Indexer tasks to Postgres",
    });

    if (edge) {
      this.distribution = this.addCloudFront(config.envName, edgePrefixList);
    }

    if (config.indexerDesiredCount === 0) {
      (this.service.service.node.defaultChild as ecs.CfnService).desiredCount = 0;
    }

    const scaling = this.service.service.autoScaleTaskCount({
      minCapacity: config.indexerDesiredCount,
      maxCapacity: Math.max(config.indexerMaxCount, config.indexerDesiredCount),
    });
    scaling.scaleOnCpuUtilization("Cpu", {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });
    scaling.scaleOnMemoryUtilization("Memory", { targetUtilizationPercent: 75 });

    new cdk.CfnOutput(this, "RepositoryUri", { value: this.repository.repositoryUri });
    const url = this.distribution
      ? `https://${this.distribution.distributionDomainName}`
      : `${https ? "https" : "http"}://${config.indexerDomainName ?? this.service.loadBalancer.loadBalancerDnsName}`;
    new cdk.CfnOutput(this, "IndexerUrl", { value: url });
    // With an externally managed DNS zone, point the domain at this name (CNAME or alias).
    new cdk.CfnOutput(this, "LoadBalancerDnsName", { value: this.service.loadBalancer.loadBalancerDnsName });
  }

  /**
   * CloudFront in front of the HTTP ALB. The ALB answers 403 unless the request carries the origin header
   * (value: this stack's UUID, never published), and optionally admits only CloudFront's origin-facing
   * prefix list. No caching: every response is live, and the activity stream's 15 s heartbeat stays well
   * inside the 60 s origin read timeout.
   */
  private addCloudFront(envName: string, prefixListId?: string): cloudfront.Distribution {
    const token = cdk.Fn.select(2, cdk.Fn.split("/", this.stackId));
    const listener = this.service.listener;

    if (prefixListId) {
      this.service.loadBalancer.connections.allowFrom(
        ec2.Peer.prefixList(prefixListId),
        ec2.Port.tcp(80),
        "CloudFront origin-facing",
      );
    }
    new elbv2.ApplicationListenerRule(this, "FromCloudFront", {
      listener,
      priority: 1,
      conditions: [elbv2.ListenerCondition.httpHeader(INDEXER_ORIGIN_HEADER, [token])],
      action: elbv2.ListenerAction.forward([this.service.targetGroup]),
    });
    (listener.node.defaultChild as elbv2.CfnListener).defaultActions = [
      { type: "fixed-response", fixedResponseConfig: { statusCode: "403", contentType: "text/plain", messageBody: "forbidden" } },
    ];

    const distribution = new cloudfront.Distribution(this, "Edge", {
      comment: `Verada ${envName} indexer API`,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(this.service.loadBalancer, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          customHeaders: { [INDEXER_ORIGIN_HEADER]: token },
          readTimeout: cdk.Duration.seconds(60),
          keepaliveTimeout: cdk.Duration.seconds(60),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Forwards Origin (CORS is decided by the indexer), query strings and Last-Event-ID.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: false,
      },
    });
    NagSuppressions.addResourceSuppressions(distribution, [
      { id: "AwsSolutions-CFR1", reason: "Public read-only API for a global audience; no geo restriction." },
      { id: "AwsSolutions-CFR2", reason: "No WAF on the dev API; the indexer applies its own per-IP rate limits." },
      { id: "AwsSolutions-CFR3", reason: "No access logs, matching the ALB: client IPs are not retained." },
      { id: "AwsSolutions-CFR4", reason: "Default *.cloudfront.net certificate (no custom domain); TLS policy is CloudFront-managed." },
      { id: "AwsSolutions-CFR5", reason: "Origin hop is HTTP to the ALB, which only forwards requests carrying the secret origin header." },
    ]);
    return distribution;
  }
}
