import * as webpack from "webpack";
import { join } from "path";
import { Volume, createFsFromVolume } from "memfs";

const loaderPath = require.resolve("../src/loader");

export class TestRunError extends Error {
  public errors: string[];

  constructor(errors: string[]) {
    super(`Test Run Compiler Error:\n${errors.join("\n")}`);

    Object.setPrototypeOf(this, TestRunError.prototype);

    this.errors = errors;
  }
}

export function runFixture(fixtureName: string): Promise<{}> {
  const config = require(
    join(__dirname, "/fixtures/", fixtureName, "webpack.config.ts"),
  );

  return new Promise((resolve, reject) => {
    const fs = createFsFromVolume(new Volume());

    const compiler = webpack({
      module: {
        rules: [
          {
            test: /\.graphql$/,
            exclude: /node_modules/,
            use: [{ loader: loaderPath }],
          },
        ],
      },
      output: {
        path: "/",
        filename: `bundle.js`,
        libraryTarget: "commonjs2",
      },
      ...config,
    });

    compiler.outputFileSystem = fs as webpack.OutputFileSystem;

    compiler.run((err, stats) => {
      if (err || stats === undefined) {
        reject(err);
      } else {
        if (stats.hasErrors()) {
          // Remove context path from error messages.
          const contextMatcher = new RegExp(
            config.context.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            "g",
          );
          const errorMessages = (stats.toJson().errors || []).map((err) =>
            err.message
              .split("\n")
              .filter((line) => !line.match(/^\s+at/))
              .map((line) => line.replace(contextMatcher, "(path-removed)"))
              .join("\n"),
          );

          reject(new TestRunError(errorMessages));
          return;
        }

        const output = fs.readFileSync("/bundle.js").toString() as string;
        eval(output);
        resolve(module.exports);
      }
    });
  });
}
