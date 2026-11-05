import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { VeradaConfig } from "./config";

const VPC_CIDR = "10.40.0.0/16";

export interface NetworkStackProps extends cdk.StackProps {
  readonly config: VeradaConfig;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;

    // Default layout has no NAT gateway and no interface endpoints (the main fixed costs): the indexer
    // tasks sit in public subnets with a public IP whose security group only admits the ALB, and the
    // database sits in isolated subnets with no route out. privateEgress restores NAT + endpoints.
    const subnetConfiguration: ec2.SubnetConfiguration[] = [
      { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
    ];
    if (config.privateEgress) {
      subnetConfiguration.push({ name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 });
    }
    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: config.privateEgress ? config.natGateways : 0,
      ipAddresses: ec2.IpAddresses.cidr(VPC_CIDR),
      subnetConfiguration,
      flowLogs: {
        all: {
          trafficType: ec2.FlowLogTrafficType.REJECT,
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, "FlowLogs", {
              retention: logs.RetentionDays.ONE_MONTH,
              removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
          ),
        },
      },
    });

    // Gateway endpoints are free and keep ECR layer pulls off the internet path.
    this.vpc.addGatewayEndpoint("S3", { service: ec2.GatewayVpcEndpointAwsService.S3 });
    if (!config.privateEgress) return;

    const endpointSg = new ec2.SecurityGroup(this, "EndpointSg", {
      vpc: this.vpc,
      description: "Interface VPC endpoints: HTTPS from inside the VPC",
      allowAllOutbound: false,
    });
    endpointSg.addIngressRule(ec2.Peer.ipv4(VPC_CIDR), ec2.Port.tcp(443), "HTTPS from VPC");
    const interfaceServices: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
      EcrDocker: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      Logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    };
    for (const [name, service] of Object.entries(interfaceServices)) {
      this.vpc.addInterfaceEndpoint(name, {
        service,
        securityGroups: [endpointSg],
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        privateDnsEnabled: true,
        open: false, // ingress is managed explicitly on endpointSg
      });
    }
  }
}
