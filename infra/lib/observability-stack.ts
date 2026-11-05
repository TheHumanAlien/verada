import * as cdk from "aws-cdk-lib";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as kms from "aws-cdk-lib/aws-kms";
import * as iam from "aws-cdk-lib/aws-iam";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { VeradaConfig } from "./config";
import { DatabaseMetrics } from "./data-stack";
import { IndexerStack } from "./indexer-stack";

/** An alarm on a log pattern: a metric filter counting matching lines, alarmed when any match in a period. */
export interface LogAlarmSpec {
  /** Construct id suffix and metric name, e.g. "PostageBatchAttention". */
  readonly id: string;
  readonly description: string;
  readonly logGroup: logs.ILogGroup;
  readonly filterPattern: logs.IFilterPattern;
  /** Window the matches are summed over; at least the interval of the job that logs the line. */
  readonly period: cdk.Duration;
}

/** A public ALB-fronted Fargate service that gets the standard alarm set on the shared topic. */
export interface MonitoredService {
  /** Construct id prefix, e.g. "Swarm" -> "SwarmUnhealthyHosts". */
  readonly id: string;
  /** Human label used in alarm descriptions and dashboard titles. */
  readonly label: string;
  readonly service: ecsPatterns.ApplicationLoadBalancedFargateService;
  /** Log-pattern alarms for this service (metric filters on its log group). */
  readonly logAlarms?: readonly LogAlarmSpec[];
}

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly config: VeradaConfig;
  readonly indexer: IndexerStack;
  readonly database: DatabaseMetrics;
  /** Further services (Swarm gateway, publisher) alarmed on the same topic. */
  readonly services?: readonly MonitoredService[];
}

export class ObservabilityStack extends cdk.Stack {
  public readonly alarmTopic: sns.Topic;
  public readonly dashboard: cw.Dashboard;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const { config, indexer, database: db } = props;

    const key = new kms.Key(this, "TopicKey", { enableKeyRotation: true });
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:GenerateDataKey*"],
        resources: ["*"],
        principals: [new iam.ServicePrincipal("cloudwatch.amazonaws.com")],
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
    );
    this.alarmTopic = new sns.Topic(this, "Alarms", { masterKey: key, enforceSSL: true });
    if (config.alarmEmail) this.alarmTopic.addSubscription(new subs.EmailSubscription(config.alarmEmail));
    const action = new cwActions.SnsAction(this.alarmTopic);

    const svc = indexer.service;
    const alb = svc.loadBalancer;
    const period = cdk.Duration.minutes(1);

    const alarms: cw.Alarm[] = [
      new cw.Alarm(this, "UnhealthyHosts", {
        alarmDescription: "Indexer has unhealthy targets behind the ALB",
        metric: svc.targetGroup.metrics.unhealthyHostCount({ period, statistic: "Maximum" }),
        threshold: 1,
        evaluationPeriods: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
      new cw.Alarm(this, "NoHealthyHosts", {
        alarmDescription: "Indexer has no healthy targets",
        metric: svc.targetGroup.metrics.healthyHostCount({ period, statistic: "Minimum" }),
        threshold: 1,
        evaluationPeriods: 3,
        comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.BREACHING,
      }),
      new cw.Alarm(this, "Target5xx", {
        alarmDescription: "Indexer is returning 5xx responses",
        metric: alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: cdk.Duration.minutes(5), statistic: "Sum" }),
        threshold: 10,
        evaluationPeriods: 2,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
      new cw.Alarm(this, "ServiceCpuHigh", {
        alarmDescription: "Indexer CPU above 85%",
        metric: svc.service.metricCpuUtilization({ period: cdk.Duration.minutes(5) }),
        threshold: 85,
        evaluationPeriods: 3,
      }),
      new cw.Alarm(this, "ServiceMemoryHigh", {
        alarmDescription: "Indexer memory above 85%",
        metric: svc.service.metricMemoryUtilization({ period: cdk.Duration.minutes(5) }),
        threshold: 85,
        evaluationPeriods: 3,
      }),
      new cw.Alarm(this, "DbCpuHigh", {
        alarmDescription: `${db.label} CPU above 80%`,
        metric: db.cpu,
        threshold: 80,
        evaluationPeriods: 3,
      }),
      new cw.Alarm(this, "DbConnectionsHigh", {
        alarmDescription: `${db.label} connection count is high`,
        metric: db.connections,
        threshold: db.connectionsThreshold,
        evaluationPeriods: 2,
      }),
    ];
    if (db.freeStorage) {
      alarms.push(
        new cw.Alarm(this, "DbStorageLow", {
          alarmDescription: `${db.label} free storage below 2 GiB`,
          metric: db.freeStorage,
          threshold: 2 * 1024 ** 3,
          evaluationPeriods: 2,
          comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
        }),
      );
    }
    for (const m of props.services ?? []) {
      const s = m.service;
      // Container Insights (enabled on every cluster) publishes the running task count per service.
      const running = new cw.Metric({
        namespace: "ECS/ContainerInsights",
        metricName: "RunningTaskCount",
        dimensionsMap: { ClusterName: s.cluster.clusterName, ServiceName: s.service.serviceName },
        period,
        statistic: "Minimum",
      });
      alarms.push(
        new cw.Alarm(this, `${m.id}UnhealthyHosts`, {
          alarmDescription: `${m.label} has unhealthy targets behind the ALB`,
          metric: s.targetGroup.metrics.unhealthyHostCount({ period, statistic: "Maximum" }),
          threshold: 1,
          evaluationPeriods: 3,
          comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        }),
        new cw.Alarm(this, `${m.id}NoRunningTasks`, {
          alarmDescription: `${m.label} has no running task`,
          metric: running,
          threshold: 1,
          evaluationPeriods: 5,
          comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
          treatMissingData: cw.TreatMissingData.BREACHING,
        }),
        new cw.Alarm(this, `${m.id}Target5xx`, {
          alarmDescription: `${m.label} is returning 5xx responses`,
          metric: s.loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
          }),
          threshold: 10,
          evaluationPeriods: 2,
          treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        }),
        new cw.Alarm(this, `${m.id}MemoryHigh`, {
          alarmDescription: `${m.label} memory above 85%`,
          metric: s.service.metricMemoryUtilization({ period: cdk.Duration.minutes(5) }),
          threshold: 85,
          evaluationPeriods: 3,
        }),
      );
      for (const l of m.logAlarms ?? []) {
        const filter = new logs.MetricFilter(this, `${m.id}${l.id}Filter`, {
          logGroup: l.logGroup,
          filterPattern: l.filterPattern,
          metricNamespace: `Verada/${config.envName}/${m.id}`,
          metricName: l.id,
          metricValue: "1",
        });
        alarms.push(
          new cw.Alarm(this, `${m.id}${l.id}`, {
            alarmDescription: l.description,
            metric: filter.metric({ statistic: "Sum", period: l.period }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            // No matching line means no datapoint: healthy.
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
          }),
        );
      }
    }
    for (const a of alarms) {
      a.addAlarmAction(action);
      a.addOkAction(action);
    }

    this.dashboard = new cw.Dashboard(this, "Dashboard", { dashboardName: `verada-${config.envName}` });
    this.dashboard.addWidgets(
      new cw.GraphWidget({
        title: "Indexer CPU / memory (%)",
        left: [svc.service.metricCpuUtilization(), svc.service.metricMemoryUtilization()],
        width: 12,
      }),
      new cw.GraphWidget({
        title: "ALB requests and 5xx",
        left: [alb.metrics.requestCount()],
        right: [alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT)],
        width: 12,
      }),
      new cw.GraphWidget({
        title: "Target health",
        left: [svc.targetGroup.metrics.healthyHostCount(), svc.targetGroup.metrics.unhealthyHostCount()],
        width: 12,
      }),
      new cw.GraphWidget({
        title: "ALB target response time (s)",
        left: [alb.metrics.targetResponseTime()],
        width: 12,
      }),
      new cw.GraphWidget({
        title: `${db.label} CPU and connections`,
        left: [db.cpu],
        right: [db.connections],
        width: 12,
      }),
      new cw.GraphWidget({
        title: db.capacityTitle,
        left: db.capacity,
        right: db.capacityRight,
        width: 12,
      }),
    );
    for (const m of props.services ?? []) {
      this.dashboard.addWidgets(
        new cw.GraphWidget({
          title: `${m.label} CPU / memory (%)`,
          left: [m.service.service.metricCpuUtilization(), m.service.service.metricMemoryUtilization()],
          width: 12,
        }),
        new cw.GraphWidget({
          title: `${m.label} target health`,
          left: [m.service.targetGroup.metrics.healthyHostCount(), m.service.targetGroup.metrics.unhealthyHostCount()],
          width: 12,
        }),
      );
    }
  }
}
