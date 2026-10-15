import { print as graphqlPrint } from "graphql/language/printer";
import { parse as graphqlParse } from "graphql/language/parser";
import { validate as graphqlValidate } from "graphql/validation/validate";
import { join, dirname } from "path";
import { Stats, stat as fsStat } from "fs";
import { removeDuplicateFragments, removeUnusedFragments } from "./transforms";

import { LoaderContext } from "webpack";
import {
  DocumentNode,
  DefinitionNode,
  GraphQLSchema,
  IntrospectionQuery,
  buildClientSchema,
  Source,
  GraphQLError,
} from "graphql";

interface CachedSchema {
  mtime: number;
  schema: GraphQLSchema;
}

let cachedSchemas: Record<string, CachedSchema> = {};

interface GraphQLLoaderOptions {
  schema?: string;
  validate?: boolean;
  removeUnusedFragments?: boolean;
  minify?: boolean;
  emitDefaultExport?: boolean;
}

async function readFile(
  loader: LoaderContext<GraphQLLoaderOptions>,
  filePath: string
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    loader.fs.readFile(filePath, (err, result) => {
      if (err || result === undefined) {
        reject(err);
      } else {
        resolve(typeof result === "string" ? result : result.toString());
      }
    });
  });
}

async function stat(
  loader: LoaderContext<GraphQLLoaderOptions>,
  filePath: string
): Promise<Stats> {
  // turbopack does not support loader.fs.stat.
  const statFn = loader.fs.stat || fsStat;

  return new Promise<Stats>((resolve, reject) => {
    statFn(filePath, (err, result) => {
      if (err || result === undefined) {
        reject(err);
      } else {
        // IStats is not exported.
        resolve(result as any as Stats);
      }
    });
  });
}

async function extractImports(
  loader: LoaderContext<GraphQLLoaderOptions>,
  resolveContext: string,
  source: string,
  document: DocumentNode
) {
  const lines = source.split(/(\r\n|\r|\n)/);

  const imports: Array<Promise<string>> = [];
  lines.forEach((line) => {
    // Find lines that match syntax with `#import "<file>"`
    if (line[0] !== "#") {
      return;
    }

    const comment = line.slice(1).split(" ");
    if (comment[0] !== "import") {
      return;
    }

    const filePathMatch = comment[1] && comment[1].match(/^["'](.+)["']/);
    if (!filePathMatch || !filePathMatch.length) {
      throw new Error("#import statement must specify a quoted file path");
    }

    const filePath = filePathMatch[1];
    imports.push(
      new Promise((resolve, reject) => {
        loader.resolve(resolveContext, filePath, (err, result) => {
          if (err || typeof result !== "string") {
            reject(err);
          } else {
            loader.addDependency(result);
            resolve(result);
          }
        });
      })
    );
  });

  const files = await Promise.all(imports);
  const contents = await Promise.all(
    files.map(async (filePath) => [
      dirname(filePath),
      await readFile(loader, filePath),
    ])
  );

  const nodes = await Promise.all(
    contents.map(([fileContext, content]) =>
      loadSource(loader, fileContext, content)
    )
  );
  const fragmentDefinitions = nodes.reduce((defs, node) => {
    defs.push(...node.definitions);
    return defs;
  }, [] as DefinitionNode[]);

  return {
    ...document,
    definitions: [...document.definitions, ...fragmentDefinitions],
  };
}

async function loadSource(
  loader: LoaderContext<GraphQLLoaderOptions>,
  resolveContext: string,
  source: string
) {
  let document: DocumentNode = graphqlParse(new Source(source, "GraphQL/file"));
  document = await extractImports(loader, resolveContext, source, document);
  return document;
}

async function loadSchema(
  loader: LoaderContext<GraphQLLoaderOptions>,
  options: GraphQLLoaderOptions
): Promise<GraphQLSchema> {
  let schema = null;

  if (options.schema) {
    const schemaPath = await findFileInTree(
      loader,
      loader.context,
      options.schema
    );
    loader.addDependency(schemaPath);

    const stats = await stat(loader, schemaPath);
    const lastChangedAt = stats.mtime.getTime();

    // Note that we always read the file before we check the cache. This is to put a
    // run-to-completion "mutex" around accesses to cachedSchemas so that updating the cache is not
    // deferred for concurrent loads. This should be reasonably inexpensive because the fs
    // read is already cached by memory-fs.
    const schemaString = await readFile(loader, schemaPath);

    // The cached version of the schema is valid as long its modification time has not changed.
    if (
      cachedSchemas[schemaPath] &&
      lastChangedAt <= cachedSchemas[schemaPath].mtime
    ) {
      return cachedSchemas[schemaPath].schema;
    }

    schema = buildClientSchema(JSON.parse(schemaString) as IntrospectionQuery);
    cachedSchemas[schemaPath] = {
      schema,
      mtime: lastChangedAt,
    };
  }

  if (!schema) {
    throw new Error("schema option must be passed if validate is true");
  }

  return schema;
}

async function loadOptions(loader: LoaderContext<GraphQLLoaderOptions>) {
  const options: GraphQLLoaderOptions = loader.getOptions();
  let schema: GraphQLSchema | undefined = undefined;
  if (options.validate) {
    schema = await loadSchema(loader, options);
  }

  return {
    schema,
    removeUnusedFragments: options.removeUnusedFragments,
    minify: options.minify,
    emitDefaultExport: options.emitDefaultExport,
  };
}

/**
 * findFileInTree returns the path for the requested file given the current context,
 * walking up towards the root until it finds the file. If the function fails to find
 * the file, it will throw an error.
 */
async function findFileInTree(
  loader: LoaderContext<GraphQLLoaderOptions>,
  context: string,
  schemaPath: string
) {
  let currentContext = context;
  while (true) {
    const fileName = join(currentContext, schemaPath);
    try {
      if ((await stat(loader, fileName)).isFile()) {
        return fileName;
      }
    } catch (err) {}
    const parent = dirname(currentContext);
    if (parent === currentContext) {
      // Reached root of the fs, but we still haven't found anything.
      throw new Error(
        `Could not find schema file '${schemaPath}' from any parent of '${context}'`
      );
    }
    currentContext = parent;
  }
}

export default async function loader(
  this: LoaderContext<GraphQLLoaderOptions>,
  source: string
) {
  this.cacheable();
  const done = this.async();
  if (!done) {
    throw new Error("Loader does not support synchronous processing");
  }

  let validationErrors: readonly GraphQLError[] = [];

  try {
    const options = await loadOptions(this);
    let document = await loadSource(this, this.context, source);

    document = removeDuplicateFragments(document);

    if (options.removeUnusedFragments) {
      document = removeUnusedFragments(document);
    }

    if (options.schema) {
      // Validate
      validationErrors = graphqlValidate(options.schema, document);
      if (validationErrors.length > 0) {
        validationErrors.forEach((err) => this.emitError(err as any));
      }
    }

    const content = JSON.stringify(graphqlPrint(document));
    const output = options.minify ? minifyDocumentString(content) : content;

    const exp = options.emitDefaultExport
      ? "export default "
      : "module.exports = ";

    done(null, `${exp}${output}`);
  } catch (err: any) {
    done(err);
  }
}

function minifyDocumentString(documentString: string) {
  return documentString
    .replace(/#.*/g, "") // remove comments
    .replace(/\\n/g, " ") // replace line breaks with space
    .replace(/\s\s+/g, " ") // replace consecutive whitespace with one space
    .replace(/\s*({|}|\(|\)|\.|:|,)\s*/g, "$1"); // remove whitespace before/after operators
}

// export {
//   removeDuplicateFragments,
//   removeSourceLocations,
//   removeUnusedFragments,
// } from "./transforms";
