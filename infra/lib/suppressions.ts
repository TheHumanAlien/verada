import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import { NagSuppressions } from "cdk-nag";
import { VeradaConfig } from "./config";
import { DataStack } from "./data-stack";
import { IndexerStack } from "./indexer-stack";
import { PublisherStack } from "./publisher-stack";
import { SwarmStack } from "./swarm-stack";

export interface SuppressionTargets {
  readonly config: VeradaConfig;
  readonly data: DataStack;
  readonly indexer: IndexerStack;
  readonly swarm?: SwarmStack;
  readonly publisher?: PublisherStack;
}

/** The same four findings apply to every public ALB-fronted Fargate service; reasons are per service. */
function suppressPublicService(
  service: ecsPatterns.ApplicationLoadBalancedFargateService,
  reasons: { publicIngress: string; inlineEnv: string; executionRole: string },
): void {
  NagSuppressions.addResourceSuppressions(service.loadBalancer, [{ id: "AwsSolutions-EC23", reason: reasons.publicIngress }], true);
  NagSuppressions.addResourceSuppressions(service.taskDefinition, [{ id: "AwsSolutions-ECS2", reason: reasons.inlineEnv }]);
  NagSuppressions.addResourceSuppressions(
    service.taskDefinition.executionRole!,
    [
      {
        id: "AwsSolutions-IAM5",
        reason: reasons.executionRole,
        appliesTo: ["Resource::*", { regex: "/^Resource::arn:.*:secret:.*-\\?{6}$/" }],
      },
    ],
    true,
  );
  NagSuppressions.addResourceSuppressions(service.loadBalancer, [
    {
      id: "AwsSolutions-ELB2",
      reason:
        "Access logs are off on purpose: they record every client IP and request path, and Verada must not be able to link users to what they view (docs/PRIVACY.md). Health and errors are covered by target-group metrics and CloudWatch alarms.",
    },
  ]);
}

/** Every suppression carries a reason; nothing is suppressed stack-wide. */
export function applySuppressions({ config, data, indexer, swarm, publisher }: SuppressionTargets): void {
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
  NagSuppressions.addResourceSuppressions(indexer.service.loadBalancer, [
    {
      id: "AwsSolutions-ELB2",
      reason:
        "Access logs are off on purpose: they record every client IP and request path, and Verada must not be able to link users to what they view (docs/PRIVACY.md). Health and errors are covered by target-group metrics and CloudWatch alarms.",
    },
  ]);

  if (swarm) {
    suppressPublicService(swarm.service, {
      publicIngress:
        "The Swarm gateway is intentionally public: the ALB accepts 80/443 from the internet and forwards only to the gateway port. Bee's API port 1633 is admitted only from the publisher's security group, never from a CIDR.",
      inlineEnv:
        "Inline environment values are non-sensitive settings (ports, Bee API listen address, loopback Bee URL, postage depth/amount, flags). The Bee password, Gnosis RPC URL and gateway auth secret are injected from Secrets Manager.",
      executionRole:
        "The Bee secret ARN ends in the Secrets Manager random suffix wildcard (imported by name); any Resource::* entry comes from CloudWatch Logs/ECR actions that do not support resource-level scoping.",
    });
  }
  if (publisher) {
    suppressPublicService(publisher.service, {
      publicIngress: "The publisher API is intentionally public: the ALB accepts 80/443 from the internet and is the only ingress.",
      inlineEnv:
        "Inline environment values are non-sensitive settings (port, public and internal service URLs, chain id, public contract addresses and start block, Arkiv chain name, keeper and dry-run flags, site feed owner/manifest, CORS list). Keys, the RPC URL, the batch id and the gateway auth secret are injected from Secrets Manager.",
      executionRole:
        "ecr:GetAuthorizationToken does not support resource-level scoping, and the publisher secret ARN ends in the Secrets Manager random suffix wildcard. Everything else is scoped to specific ARNs.",
    });
  }
}
