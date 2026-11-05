#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
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

const app = new cdk.App();
const config = loadConfig(app.node);
const env: cdk.Environment = { account: config.account, region: config.region };
const prefix = `Verada-${config.envName}`;
const common = { env, config, tags: { Project: "verada", Environment: config.envName } };

const network = new NetworkStack(app, `${prefix}-Network`, common);
const data = new DataStack(app, `${prefix}-Data`, {
  ...common,
  vpc: network.vpc,
  terminationProtection: config.isProd,
});
const indexer = new IndexerStack(app, `${prefix}-Indexer`, {
  ...common,
  vpc: network.vpc,
  dbSecret: data.secret,
  dbSecurityGroup: data.securityGroup,
  dbName: data.databaseName,
});
// Swarm before Publisher; the publisher reaches the gateway by its public URL from context only.
const swarm = new SwarmStack(app, `${prefix}-Swarm`, { ...common, vpc: network.vpc });
const publisher = new PublisherStack(app, `${prefix}-Publisher`, { ...common, vpc: network.vpc });
publisher.addDependency(swarm, "deploy the gateway before the service that uploads through it");
new ObservabilityStack(app, `${prefix}-Observability`, {
  ...common,
  indexer,
  database: data.metrics,
  services: [
    { id: "Swarm", label: "Swarm gateway", service: swarm.service },
    { id: "Publisher", label: "Publisher", service: publisher.service },
  ],
});

applySuppressions({ config, data, indexer, swarm, publisher });
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
