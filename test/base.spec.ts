import { runFixture, TestRunError } from "./runner";

describe("graphql-loader", function () {
  [
    "simple",
    "fragments",
    "fragments-common-duplicates",
    "validator",
    "fail-invalid-document",
    "fail-invalid-field",
    "fail-invalid-schema-path",
    "fail-missing-fragment",
    "fail-missing-schema-path",
    "filter-unused-fragments",
    "issue-1-import-from-fragment",
    "two-loaders",
    "minify",
  ].forEach((fixturePath) =>
    it(fixturePath, async function () {
      try {
        const document = await runFixture(fixturePath);
        expect(document).toMatchSnapshot();
      } catch (err) {
        if (err instanceof TestRunError) {
          expect(err.errors).toMatchSnapshot();
        } else {
          throw err;
        }
      }
    }),
  );
});
