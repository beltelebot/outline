// @flow
import * as Sentry from "@sentry/node";
import Koa from "koa";
import compress from "koa-compress";
import helmet, {
  contentSecurityPolicy,
  dnsPrefetchControl,
  referrerPolicy,
} from "koa-helmet";
import logger from "koa-logger";
import mount from "koa-mount";
import onerror from "koa-onerror";
import enforceHttps from "koa-sslify";
import api from "./api";
import auth from "./auth";
import emails from "./emails";
import env from "./env";
import routes from "./routes";
import updates from "./utils/updates";

const app = new Koa();
const isProduction = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";

// Construct scripts CSP based on services in use by this installation
const defaultSrc = ["'self'"];
const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  "'unsafe-eval'",
  "gist.github.com",
  "browser.sentry-cdn.com",
];

if (env.GOOGLE_ANALYTICS_ID) {
  scriptSrc.push("www.google-analytics.com");
}
if (env.CDN_URL) {
  scriptSrc.push(env.CDN_URL);
  defaultSrc.push(env.CDN_URL);
}

app.use(compress());

if (isProduction) {
  // Force redirect to HTTPS protocol unless explicitly disabled
  if (process.env.FORCE_HTTPS !== "false") {
    app.use(
      enforceHttps({
        trustProtoHeader: true,
      })
    );
  } else {
    console.warn("Enforced https was disabled with FORCE_HTTPS env variable");
  }

  // trust header fields set by our proxy. eg X-Forwarded-For
  app.proxy = true;
} else if (!isTest) {
  /* eslint-disable global-require */
  const convert = require("koa-convert");
  const webpack = require("webpack");
  const devMiddleware = require("koa-webpack-dev-middleware");
  const hotMiddleware = require("koa-webpack-hot-middleware");
  const config = require("../webpack.config.dev");
  const compile = webpack(config);
  /* eslint-enable global-require */

  const middleware = devMiddleware(compile, {
    // display no info to console (only warnings and errors)
    noInfo: true,

    // display nothing to the console
    quiet: false,

    // switch into lazy mode
    // that means no watching, but recompilation on every request
    lazy: false,

    // public path to bind the middleware to
    // use the same as in webpack
    publicPath: config.output.publicPath,

    // options for formatting the statistics
    stats: {
      colors: true,
    },
  });

  app.use(async (ctx, next) => {
    ctx.webpackConfig = config;
    ctx.devMiddleware = middleware;
    await next();
  });
  app.use(convert(middleware));
  app.use(
    convert(
      hotMiddleware(compile, {
        log: console.log, // eslint-disable-line
        path: "/__webpack_hmr",
        heartbeat: 10 * 1000,
      })
    )
  );
  app.use(logger());

  app.use(mount("/emails", emails));
}

// catch errors in one place, automatically set status and response headers
onerror(app);

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    maxBreadcrumbs: 0,
    ignoreErrors: [
      // emitted by Koa when bots attempt to snoop on paths such as wp-admin
      // or the user submits a bad request. These are expected in normal running
      // of the application
      "BadRequestError",
      "UnauthorizedError",
    ],
  });
}

app.on("error", (error, ctx) => {
  // we don't need to report every time a request stops to the bug tracker
  if (error.code === "EPIPE" || error.code === "ECONNRESET") {
    console.warn("Connection error", { error });
    return;
  }

  if (process.env.SENTRY_DSN) {
    Sentry.withScope(function (scope) {
      const requestId = ctx.headers["x-request-id"];
      if (requestId) {
        scope.setTag("request_id", requestId);
      }

      const authType = ctx.state ? ctx.state.authType : undefined;
      if (authType) {
        scope.setTag("auth_type", authType);
      }

      const userId =
        ctx.state && ctx.state.user ? ctx.state.user.id : undefined;
      if (userId) {
        scope.setUser({ id: userId });
      }

      scope.addEventProcessor(function (event) {
        return Sentry.Handlers.parseRequest(event, ctx.request);
      });
      Sentry.captureException(error);
    });
  } else {
    console.error(error);
  }
});

app.use(mount("/auth", auth));
app.use(mount("/api", api));

app.use(helmet());
app.use(
  contentSecurityPolicy({
    directives: {
      defaultSrc,
      scriptSrc,
      styleSrc: ["'self'", "'unsafe-inline'", "github.githubassets.com"],
      imgSrc: ["*", "data:", "blob:"],
      frameSrc: ["*"],
      connectSrc: ["*"],
      // Removed because connect-src: self + websockets does not work in Safari
      // Ref: https://bugs.webkit.org/show_bug.cgi?id=201591
      // connectSrc: compact([
      //   "'self'",
      //   process.env.AWS_S3_UPLOAD_BUCKET_URL.replace("s3:", "localhost:"),
      //   "www.google-analytics.com",
      //   "api.github.com",
      //   "sentry.io",
      // ]),
    },
  })
);
app.use(dnsPrefetchControl({ allow: true }));
app.use(referrerPolicy({ policy: "no-referrer" }));
app.use(mount(routes));

/**
 * Production updates and anonymous analytics.
 *
 * Set ENABLE_UPDATES=false to disable them for your installation
 */
if (process.env.ENABLE_UPDATES !== "false" && isProduction) {
  updates();
  setInterval(updates, 24 * 3600 * 1000);
}

export default app;
