import * as cdk from "aws-cdk-lib";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { VeradaConfig } from "./config";

export interface DataStackProps extends cdk.StackProps {
  readonly config: VeradaConfig;
  readonly vpc: ec2.IVpc;
}

/** Engine-neutral metrics so the observability stack does not care which dbMode is deployed. */
export interface DatabaseMetrics {
  readonly label: string;
  readonly cpu: cw.IMetric;
  readonly connections: cw.IMetric;
  readonly connectionsThreshold: number;
  /** Capacity / storage series for the dashboard. */
  readonly capacityTitle: string;
  readonly capacity: cw.IMetric[];
  /** Optional second-axis series (different unit) for the same widget. */
  readonly capacityRight?: cw.IMetric[];
  /** Only set when free storage is a meaningful alarm (fixed-size volume). */
  readonly freeStorage?: cw.IMetric;
}

/**
 * Postgres for the indexer. dbMode "rds": one single-AZ db.t4g.micro instance (dev default).
 * dbMode "aurora": Aurora Serverless v2 (prod default). Credentials are generated into Secrets Manager.
 */
export class DataStack extends cdk.Stack {
  /** The RDS instance or Aurora cluster construct. */
  public readonly database: Construct;
  public readonly secret: secretsmanager.ISecret;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly metrics: DatabaseMetrics;
  public readonly databaseName = "verada";
  /** Rotation runs in the VPC and needs the Secrets Manager endpoint, so it exists only with privateEgress. */
  public readonly rotationEnabled: boolean;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;
    this.rotationEnabled = config.privateEgress;

    this.securityGroup = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      description: "Postgres; ingress granted by consumers via connections",
      allowAllOutbound: false,
    });

    const credentials = rds.Credentials.fromGeneratedSecret("verada", {
      secretName: `verada/${config.envName}/db-credentials`,
    });
    const isolated = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

    if (config.dbMode === "aurora") {
      const cluster = new rds.DatabaseCluster(this, "Cluster", {
        engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.of("16.8", "16") }),
        credentials,
        defaultDatabaseName: this.databaseName,
        vpc,
        vpcSubnets: isolated,
        securityGroups: [this.securityGroup],
        writer: rds.ClusterInstance.serverlessV2("writer", { autoMinorVersionUpgrade: true }),
        readers: config.isProd ? [rds.ClusterInstance.serverlessV2("reader", { scaleWithWriter: true })] : [],
        serverlessV2MinCapacity: 0.5,
        serverlessV2MaxCapacity: config.isProd ? 8 : 2,
        storageEncrypted: true,
        iamAuthentication: true,
        backup: { retention: cdk.Duration.days(backupRetentionDays(this, config.isProd)) },
        deletionProtection: config.isProd,
        removalPolicy: config.isProd ? cdk.RemovalPolicy.SNAPSHOT : cdk.RemovalPolicy.DESTROY,
        cloudwatchLogsExports: ["postgresql"],
        copyTagsToSnapshot: true,
      });
      this.database = cluster;
      this.secret = cluster.secret!;
      if (this.rotationEnabled) cluster.addRotationSingleUser({ automaticallyAfter: cdk.Duration.days(30) });
      this.metrics = {
        label: "Aurora",
        cpu: cluster.metricCPUUtilization({ period: cdk.Duration.minutes(5) }),
        connections: cluster.metricDatabaseConnections({ period: cdk.Duration.minutes(5) }),
        connectionsThreshold: 200,
        capacityTitle: "Aurora capacity (ACU)",
        capacity: [
          new cw.Metric({
            namespace: "AWS/RDS",
            metricName: "ServerlessDatabaseCapacity",
            dimensionsMap: { DBClusterIdentifier: cluster.clusterIdentifier },
            statistic: "Average",
          }),
        ],
      };
    } else {
      const instance = new rds.DatabaseInstance(this, "Instance", {
        engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.of("16.8", "16") }),
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
        credentials,
        databaseName: this.databaseName,
        vpc,
        vpcSubnets: isolated,
        securityGroups: [this.securityGroup],
        publiclyAccessible: false,
        multiAz: config.isProd, // dev is single-AZ by design (cost)
        allocatedStorage: 20,
        maxAllocatedStorage: 100,
        storageType: rds.StorageType.GP3,
        storageEncrypted: true,
        iamAuthentication: true,
        backupRetention: cdk.Duration.days(backupRetentionDays(this, config.isProd)),
        deletionProtection: config.isProd,
        deleteAutomatedBackups: !config.isProd,
        removalPolicy: config.isProd ? cdk.RemovalPolicy.SNAPSHOT : cdk.RemovalPolicy.DESTROY,
        cloudwatchLogsExports: ["postgresql"],
        autoMinorVersionUpgrade: true,
        copyTagsToSnapshot: true,
      });
      this.database = instance;
      this.secret = instance.secret!;
      if (this.rotationEnabled) instance.addRotationSingleUser({ automaticallyAfter: cdk.Duration.days(30) });
      const freeStorage = instance.metricFreeStorageSpace({ period: cdk.Duration.minutes(5) });
      this.metrics = {
        label: "RDS",
        cpu: instance.metricCPUUtilization({ period: cdk.Duration.minutes(5) }),
        connections: instance.metricDatabaseConnections({ period: cdk.Duration.minutes(5) }),
        connectionsThreshold: 80, // db.t4g.micro (1 GiB) caps near 110 connections
        capacityTitle: "RDS free storage (bytes) and CPU credit balance",
        capacity: [freeStorage],
        capacityRight: [instance.metric("CPUCreditBalance", { statistic: "Minimum", period: cdk.Duration.minutes(5) })],
        freeStorage,
      };
    }
  }
}

/**
 * Automated-backup retention. Defaults: 14 days prod, 3 days otherwise. -c dbBackupRetentionDays=N
 * overrides it (1-35), e.g. 1 on AWS free-plan accounts, which reject longer retention. Prod keeps >= 7.
 */
function backupRetentionDays(scope: Construct, isProd: boolean): number {
  const raw = scope.node.tryGetContext("dbBackupRetentionDays");
  if (raw === undefined || raw === "") return isProd ? 14 : 3;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 35) throw new Error('context "dbBackupRetentionDays" must be an integer from 1 to 35');
  if (isProd && n < 7) throw new Error('context "dbBackupRetentionDays" must be at least 7 in prod');
  return n;
}
