import * as _ from "lodash";
import * as request from "request";
import * as semver from "semver";
import * as Serverless from "serverless";
import * as util from "util";

// shim for testing when we don't have layer-arn server yet
const layerArns = {
  "nodejs10.x": "arn:aws:lambda:us-east-1:554407330061:layer:MainlandLayer:9",
  "nodejs8.10": "arn:aws:lambda:us-east-1:554407330061:layer:MainlandLayer:9"
};

export default class NewRelicLambdaLayerPlugin {
  get config() {
    return _.get(this.serverless, "service.custom.newRelic", {});
  }

  get functions() {
    return Object.assign.apply(
      null,
      this.serverless.service
        .getAllFunctions()
        .map(func => ({ [func]: this.serverless.service.getFunction(func) }))
    );
  }
  public serverless: Serverless;
  public options: Serverless.Options;
  public awsProvider: any;
  public hooks: {
    [event: string]: Promise<any>;
  };

  constructor(serverless: Serverless, options: Serverless.Options) {
    this.serverless = serverless;
    this.options = options;
    this.awsProvider = this.serverless.getProvider("aws") as any;
    this.hooks = {
      "after:deploy:deploy": this.addLogStreamFilters.bind(this),
      "after:deploy:function:packageFunction": this.cleanup.bind(this),
      "after:package:createDeploymentArtifacts": this.cleanup.bind(this),
      "before:deploy:function:packageFunction": this.run.bind(this),
      "before:package:createDeploymentArtifacts": this.run.bind(this),
      "before:remove:remove": this.removeLogStreamFilters.bind(this)
    };
  }

  public async run() {
    const version = this.serverless.getVersion();
    if (semver.lt(version, "1.34.0")) {
      this.serverless.cli.log(
        `Serverless ${version} does not support layers. Please upgrade to >=1.34.0.`
      );
      return;
    }

    const plugins = _.get(this.serverless, "service.plugins", []);
    this.serverless.cli.log(`Plugins: ${JSON.stringify(plugins)}`);
    if (
      plugins.indexOf("serverless-webpack") >
      plugins.indexOf("serverless-newrelic-layers")
    ) {
      this.serverless.cli.log(
        "serverless-newrelic-layers plugin must come after serverless-webpack in serverless.yml; skipping."
      );
      return;
    }

    const funcs = this.functions;
    Object.keys(funcs).forEach(async funcName => {
      const funcDef = funcs[funcName];
      await this.addLayer(funcName, funcDef);
    });
  }

  public cleanup() {
    // any artifacts can be removed here
  }

  public async addLogStreamFilters() {
    const funcs = this.functions;
    Object.keys(funcs).forEach(async funcName => {
      const { exclude = [] } = this.config;
      if (_.isArray(exclude) && exclude.indexOf(funcName) !== -1) {
        return;
      }

      const { name } = funcs[funcName];
      this.serverless.cli.log(
        `Configuring New Relic log stream filter for ${name}`
      );
      await this.ensureLogStreamFilter(name);
    });
  }

  public async removeLogStreamFilters() {
    const funcs = this.functions;
    Object.keys(funcs).forEach(async funcName => {
      const { name } = funcs[funcName];
      this.serverless.cli.log(
        `Removing New Relic log stream filter for ${funcName}`
      );
      await this.removeSubscriptionFilter(name);
    });
  }

  private async addLayer(funcName: string, funcDef: any) {
    this.serverless.cli.log(`Adding NewRelic layer to ${funcName}`);

    const region = _.get(this.serverless.service, "provider.region");
    if (!region) {
      this.serverless.cli.log(
        "No AWS region specified for NewRelic layer; skipping."
      );
      return;
    }

    const {
      name,
      environment = {},
      handler,
      runtime = _.get(this.serverless.service, "provider.runtime"),
      layers = [],
      package: pkg = {}
    } = funcDef;

    if (!this.config.accountId && !environment.NEW_RELIC_ACCOUNT_ID) {
      this.serverless.cli.log(
        `No New Relic Account ID specified for "${funcName}"; skipping.`
      );
      return;
    }

    if (
      typeof runtime !== "string" ||
      [
        "nodejs12.x",
        "nodejs10.x",
        "nodejs8.10",
        "python2.7",
        "python3.6",
        "python3.7"
      ].indexOf(runtime) === -1
    ) {
      this.serverless.cli.log(
        `Unsupported runtime "${runtime}" for NewRelic layer; skipping.`
      );
      return;
    }

    const { exclude = [] } = this.config;
    if (_.isArray(exclude) && exclude.indexOf(funcName) !== -1) {
      this.serverless.cli.log(`Excluded function ${funcName}; skipping`);
      return;
    }

    const layerArn = this.config.layerArn
      ? this.config.layerArn
      : await this.getLayerArn(runtime, region);

    const newRelicLayers = layers.filter(
      layer => typeof layer === "string" && layer.match(layerArn)
    );

    if (newRelicLayers.length) {
      this.serverless.cli.log(
        `Function "${funcName}" already specifies an NewRelic layer; skipping.`
      );
    } else {
      if (typeof this.config.prepend === "boolean" && this.config.prepend) {
        layers.unshift(layerArn);
      } else {
        layers.push(layerArn);
      }

      funcDef.layers = layers;
    }

    environment.NEW_RELIC_LAMBDA_HANDLER = handler;

    environment.NEW_RELIC_LOG = environment.NEW_RELIC_LOG
      ? environment.NEW_RELIC_LOG
      : "stdout";

    environment.NEW_RELIC_LOG_LEVEL = environment.NEW_RELIC_LOG_LEVEL
      ? environment.NEW_RELIC_LOG_LEVEL
      : this.config.debug
      ? "debug"
      : "info";

    environment.NEW_RELIC_NO_CONFIG_FILE = environment.NEW_RELIC_NO_CONFIG_FILE
      ? environment.NEW_RELIC_NO_CONFIG_FILE
      : "true";

    environment.NEW_RELIC_APP_NAME = environment.NEW_RELIC_APP_NAME
      ? environment.NEW_RELIC_APP_NAME
      : name || funcName;

    environment.NEW_RELIC_ACCOUNT_ID = environment.NEW_RELIC_ACCOUNT_ID
      ? environment.NEW_RELIC_ACCOUNT_ID
      : this.config.accountId;

    environment.NEW_RELIC_TRUSTED_ACCOUNT_KEY = environment.NEW_RELIC_TRUSTED_ACCOUNT_KEY
      ? environment.NEW_RELIC_TRUSTED_ACCOUNT_KEY
      : environment.NEW_RELIC_ACCOUNT_ID
      ? environment.NEW_RELIC_ACCOUNT_ID
      : this.config.trustedAccountKey;

    environment.NEW_RELIC_SERVERLESS_MODE_ENABLED = "true"
      ? environment.NEW_RELIC_SERVERLESS_MODE_ENABLED
      : "true"
      ? this.config.serverlessModeEnabled
      : "false";

    funcDef.environment = environment;

    funcDef.handler = this.getHandlerWrapper(runtime, handler);
    funcDef.package = this.updatePackageExcludes(runtime, pkg);
  }

  private async getLayerArn(runtime: string, region: string) {
    return util
      .promisify(request)(
        `https://${region}.nr-layers.iopipe.com/get-layers?CompatibleRuntime=${runtime}`
      )
      .then(response => {
        const awsResp = JSON.parse(response.body);
        return _.get(
          awsResp,
          "Layers[0].LatestMatchingVersion.LayerVersionArn"
        );
      });
  }

  private getHandlerWrapper(runtime: string, handler: string) {
    if (
      ["nodejs8.10", "nodejs10.x", "nodejs12.x"].indexOf(runtime) !== -1 ||
      (runtime === "nodejs10.x" &&
        _.get(this.serverless, "enterpriseEnabled", false))
    ) {
      return "newrelic-lambda-wrapper.handler";
    }

    // if (runtime === "nodejs10.x" || runtime === "nodejs12.x") {
    //   this.serverless.cli.log(`setting full path for wrapper`);
    //   return "/opt/nodejs/node_modules/newrelic-lambda-wrapper.handler";
    // }

    if (runtime.match("python")) {
      return "newrelic_lambda_wrapper.handler";
    }

    return handler;
  }

  private updatePackageExcludes(runtime: string, pkg: any) {
    if (!runtime.match("nodejs")) {
      return pkg;
    }

    const { exclude = [] } = pkg;
    exclude.push("!newrelic-lambda-wrapper.handler");
    pkg.exclude = exclude;
    return pkg;
  }

  private async ensureLogStreamFilter(funcName: string) {
    return this.awsProvider
      .request("Lambda", "getFunction", { FunctionName: funcName })
      .then(res => {
        return this.getDestinationArn(funcName);
      })
      .catch(err => {
        this.serverless.cli.log(err.providerError.message);
      });
  }

  private async getDestinationArn(funcName: string) {
    return this.awsProvider
      .request("Lambda", "getFunction", {
        FunctionName: "newrelic-log-ingestion"
      })
      .then(res => {
        const destinationArn = res.Configuration.FunctionArn;
        return this.describeSubscriptionFilters(funcName, destinationArn);
      })
      .catch(err => {
        this.serverless.cli.log(err.providerError.message);
      });
  }

  private async describeSubscriptionFilters(
    funcName: string,
    destinationArn: string
  ) {
    return this.awsProvider
      .request("CloudWatchLogs", "describe-SubscriptionFilters", {
        logGroupName: `/aws/lambda/${funcName}`
      })
      .then(res => {
        const existingFilters = res.filter(
          filter => filter.filterName === "NewRelicLogStreaming"
        );

        if (existingFilters.length) {
          existingFilters
            .filter(filter => filter.filterPattern !== "NR_LAMBDA_MONITORING")
            .map(async filter => this.removeSubscriptionFilter(funcName))
            .map(async filter =>
              this.addSubscriptionFilter(funcName, destinationArn)
            );
        } else {
          return this.addSubscriptionFilter(funcName, destinationArn);
        }
      })
      .catch(err => {
        this.serverless.cli.log(err.providerError.message);
      });
  }

  private async addSubscriptionFilter(
    funcName: string,
    destinationArn: string
  ) {
    return this.awsProvider
      .request("CloudWatchLogs", "putSubscriptionFilter", {
        destinationArn,
        filterName: "NewRelicLogStreaming",
        filterPattern: "NR_LAMBDA_MONITORING",
        logGroupName: `/aws/lambda/${funcName}`
      })
      .catch(err => {
        this.serverless.cli.log(err.providerError.message);
      });
  }

  private removeSubscriptionFilter(funcName: string) {
    return this.awsProvider
      .request("CloudWatchLogs", "DeleteSubscriptionFilter", {
        filterName: "NewRelicLogStreaming",
        logGroupName: `/aws/lambda/${funcName}`
      })
      .catch(err => {
        this.serverless.cli.log(err.providerError.message);
      });
  }
}

module.exports = NewRelicLambdaLayerPlugin;