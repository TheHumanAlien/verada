import { NagSuppressions } from "cdk-nag";
import { VeradaConfig } from "./config";
import { DataStack } from "./data-stack";
import { IndexerStack } from "./indexer-stack";

export interface SuppressionTargets {
  readonly config: VeradaConfig;
  readonly data: DataStack;
  readonly indexer: IndexerStack;
}

/** Every suppression carries a reason; nothing is suppressed stack-wide. */
export function applySuppressions({ config, data, indexer }: SuppressionTargets): void {
  if (!config.isProd) {
    NagSuppressions.addResourceSuppressions(data.database, [
      {
        id: "AwsSolutions-RDS10",
        reason: "Deletion protection is enabled for prod only; non-prod stacks must be destroyable to avoid orphaned cost.",
      },
      {
        id: "AwsSolutions-RDS3",
        reason: "Non-prod RDS is single-AZ by design to keep fixed cost minimal; prod enables Multi-AZ (or Aurora with a reader).",
      },
    ]);
  }
  NagSuppressions.addResourceSuppressions(data.database, [
    {
      id: "AwsSolutions-RDS11",
      reason: "The default Postgres port is kept so the secret, security group rule and indexer agree; access is limited to the indexer task security group in isolated subnets with no public route.",
    },
  ]);
  if (!data.rotationEnabled) {
    NagSuppressions.addResourceSuppressions(
      data.database,
      [
        {
          id: "AwsSolutions-SMG4",
          reason:
            "Rotation needs a Lambda inside the VPC that can reach Secrets Manager, which requires the paid interface endpoint or NAT. The default low-cost network omits both; the database is in isolated subnets and the secret is used only by the indexer task. Rotation is enabled automatically with -c privateEgress=true.",
        },
      ],
      true,
    );
  }

  NagSuppressions.addResourceSuppressions(
    indexer.service.loadBalancer,
    [
      {
        id: "AwsSolutions-EC23",
        reason: "The indexer API is intentionally public: the ALB accepts 80/443 from the internet and is the only ingress.",
      },
    ],
    true,
  );
  NagSuppressions.addResourceSuppressions(indexer.service.taskDefinition, [
    {
      id: "AwsSolutions-ECS2",
      reason: "Inline environment values are non-sensitive settings (port, chain id, schema). Credentials and the RPC URL are injected from Secrets Manager.",
    },
  ]);
  NagSuppressions.addResourceSuppressions(
    indexer.service.taskDefinition.executionRole!,
    [
      {
        id: "AwsSolutions-IAM5",
        reason:
          "ecr:GetAuthorizationToken does not support resource-level scoping, and the RPC secret ARN ends in the Secrets Manager random suffix wildcard. Everything else is scoped to specific ARNs.",
        appliesTo: ["Resource::*", { regex: "/^Resource::arn:.*:secret:.*-\\?{6}$/" }],
      },
    ],
    true,
  );
  NagSuppressions.addResourceSuppressions(indexer.node.findChild("AlbLogs"), [
    {
      id: "AwsSolutions-S1",
      reason: "This bucket is the ALB access-log sink; logging a log bucket to itself adds no audit value.",
    },
  ]);
}
