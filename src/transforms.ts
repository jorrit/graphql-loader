import {
  DocumentNode,
  SelectionSetNode,
  DefinitionNode,
  Location,
} from "graphql/language/ast";

export function removeDuplicateFragments(document: DocumentNode): DocumentNode {
  const usedName = new Set();

  return {
    ...document,
    definitions: document.definitions.filter((def) => {
      if (def.kind !== "FragmentDefinition") {
        return true;
      }

      const name = def.name.value;
      if (usedName.has(name)) {
        return false;
      } else {
        usedName.add(name);
        return true;
      }
    }),
  };
}

export function removeUnusedFragments(document: DocumentNode): DocumentNode {
  const usedFragments = new Set();
  function findFragmentSpreads(doc: DocumentNode) {
    function traverse(selectionSet: SelectionSetNode) {
      selectionSet.selections.forEach((selection) => {
        if (selection.kind === "FragmentSpread") {
          usedFragments.add(selection.name.value);
        } else if (selection.selectionSet) {
          traverse(selection.selectionSet);
        }
      });
    }
    doc.definitions.forEach((def) => {
      if (
        def.kind === "OperationDefinition" ||
        def.kind === "FragmentDefinition"
      ) {
        traverse(def.selectionSet);
      }
    });
  }
  findFragmentSpreads(document);

  const defCount = document.definitions.length;
  let result: DocumentNode = {
    ...document,
    definitions: document.definitions.filter(
      (def) =>
        def.kind !== "FragmentDefinition" || usedFragments.has(def.name.value),
    ),
  };

  if (defCount !== result.definitions.length) {
    // Some references may have been from fragments that were just recently unused.
    // If we removed any fragments, run the function again until we are no longer
    // removing any fragments.
    result = removeUnusedFragments(result);
  }

  return result;
}
