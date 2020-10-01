/**
 * @license Copyright 2020 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @fileoverview
 * Creates treemap data for treemap app.
 */

const Audit = require('./audit.js');
const JsBundles = require('../computed/js-bundles.js');
const UnusedJavaScriptSummary = require('../computed/unused-javascript-summary.js');
const ModuleDuplication = require('../computed/module-duplication.js');

/**
 * @typedef {RootNodeContainer[]} TreemapData
 */

/**
 * Ex: https://gist.github.com/connorjclark/0ef1099ae994c075e36d65fecb4d26a7
 * @typedef RootNodeContainer
 * @property {string} name Arbitrary name identifier. Usually a script url.
 * @property {Node} node
 */

/**
 * @typedef Node
 * @property {string} name Arbitrary name identifier. Usually a path component from a source map.
 * @property {number} resourceBytes
 * @property {number=} unusedBytes
 * @property {string=} duplicate If present, this module is a duplicate. String is normalized source path. See ModuleDuplication.normalizeSource
 * @property {Node[]=} children
 */

/**
 * @typedef {Omit<Node, 'name'|'children'>} SourceData
 */

class TreemapDataAudit extends Audit {
  /**
   * @return {LH.Audit.Meta}
   */
  static get meta() {
    return {
      id: 'treemap-data',
      scoreDisplayMode: Audit.SCORING_MODES.INFORMATIVE,
      title: 'Treemap Data',
      description: 'Used for treemap app',
      requiredArtifacts:
        ['traces', 'devtoolsLogs', 'SourceMaps', 'ScriptElements', 'JsUsage', 'URL'],
    };
  }

  /**
   * Returns a tree data structure where leaf nodes are sources (ie. real files from source tree)
   * from a source map, and non-leaf nodes are directories. Leaf nodes have data
   * for bytes, coverage, etc., when available, and non-leaf nodes have the
   * same data as the sum of all descendant leaf nodes.
   * @param {string} sourceRoot
   * @param {Record<string, SourceData>} sourcesData
   * @return {Node}
   */
  static prepareTreemapNodes(sourceRoot, sourcesData) {
    /**
     * @param {string} name
     * @return {Node}
     */
    function newNode(name) {
      return {
        name,
        resourceBytes: 0,
      };
    }

    const topNode = newNode(sourceRoot);

    /**
     * Given a slash-delimited path, traverse the Node structure and increment
     * the data provided for each node in the chain. Creates nodes as needed.
     * Ex: path/to/file.js will find or create "path" on `node`, increment the data fields,
     *     and continue with "to", and so on.
     * @param {string} source
     * @param {SourceData} data
     */
    function addAllNodesInSourcePath(source, data) {
      let node = topNode;

      // Apply the data to the topNode.
      topNode.resourceBytes += data.resourceBytes;
      if (data.unusedBytes) topNode.unusedBytes = (topNode.unusedBytes || 0) + data.unusedBytes;

      // Strip off the shared root.
      const sourcePathSegments = source.replace(sourceRoot, '').split(/\/+/);
      sourcePathSegments.forEach((sourcePathSegment, i) => {
        const isLastSegment = i === sourcePathSegments.length - 1;

        let child = node.children && node.children.find(child => child.name === sourcePathSegment);
        if (!child) {
          child = newNode(sourcePathSegment);
          node.children = node.children || [];
          node.children.push(child);
        }
        node = child;

        // Now that we've found or created the next node in the path, apply the data.
        node.resourceBytes += data.resourceBytes;
        if (data.unusedBytes) node.unusedBytes = (node.unusedBytes || 0) + data.unusedBytes;

        // Only leaf nodes might have duplication data.
        if (isLastSegment && data.duplicate !== undefined) {
          node.duplicate = data.duplicate;
        }
      });
    }

    // For every source file, apply the data to all components
    // of the source path, creating nodes as necessary.
    for (const [source, data] of Object.entries(sourcesData)) {
      addAllNodesInSourcePath(source || `<unmapped>`, data);
    }

    /**
     * Collapse nodes that have only one child.
     * @param {Node} node
     */
    function collapseAll(node) {
      while (node.children && node.children.length === 1) {
        node.name += '/' + node.children[0].name;
        node.children = node.children[0].children;
      }

      if (node.children) {
        for (const child of node.children) {
          collapseAll(child);
        }
      }
    }
    collapseAll(topNode);

    // TODO(cjamcl): Should this structure be flattened for space savings?
    // Like DOM Snapshot.
    // Less JSON (no super nested children, and no repeated property names).

    return topNode;
  }

  /**
   * Returns root node containers where the first level of nodes are script URLs.
   * If a script has a source map, that node will be set by prepareTreemapNodes.
   * @param {LH.Artifacts} artifacts
   * @param {LH.Audit.Context} context
   * @return {Promise<RootNodeContainer[]>}
   */
  static async makeRootNodes(artifacts, context) {
    /** @type {RootNodeContainer[]} */
    const rootNodeContainers = [];

    let inlineScriptLength = 0;
    for (const scriptElement of artifacts.ScriptElements) {
      // No src means script is inline.
      // Combine these ScriptElements so that inline scripts show up as a single root node.
      if (!scriptElement.src) {
        inlineScriptLength += (scriptElement.content || '').length;
      }
    }
    if (inlineScriptLength) {
      const name = artifacts.URL.finalUrl;
      rootNodeContainers.push({
        name,
        node: {
          name,
          resourceBytes: inlineScriptLength,
        },
      });
    }

    const bundles = await JsBundles.request(artifacts, context);
    const duplicationByPath = await ModuleDuplication.request(artifacts, context);

    for (const scriptElement of artifacts.ScriptElements) {
      if (!scriptElement.src) continue;

      const name = scriptElement.src;
      const bundle = bundles.find(bundle => scriptElement.src === bundle.script.src);
      const scriptCoverages = artifacts.JsUsage[scriptElement.src];
      if (!bundle || !scriptCoverages) {
        rootNodeContainers.push({
          name,
          node: {
            name,
            resourceBytes: scriptElement.src.length,
          },
        });
        continue;
      }

      const unusedJavascriptSummary = await UnusedJavaScriptSummary.request(
        {url: scriptElement.src, scriptCoverages, bundle}, context);

      /** @type {Node} */
      let node;
      if (unusedJavascriptSummary.sourcesWastedBytes) {
        // Create nodes for each module in a bundle.

        /** @type {Record<string, SourceData>} */
        const sourcesData = {};
        for (const source of Object.keys(bundle.sizes.files)) {
          /** @type {SourceData} */
          const sourceData = {
            resourceBytes: bundle.sizes.files[source],
            unusedBytes: unusedJavascriptSummary.sourcesWastedBytes[source],
          };

          const key = ModuleDuplication.normalizeSource(source);
          if (duplicationByPath.has(key)) sourceData.duplicate = key;

          sourcesData[source] = sourceData;
        }

        node = this.prepareTreemapNodes(bundle.rawMap.sourceRoot || '', sourcesData);
      } else {
        // There was no source map for this script, so we can only produce a single node.

        node = {
          name,
          resourceBytes: unusedJavascriptSummary.totalBytes,
          unusedBytes: unusedJavascriptSummary.wastedBytes,
        };
      }

      rootNodeContainers.push({
        name,
        node,
      });
    }

    return rootNodeContainers;
  }

  /**
   * @param {LH.Artifacts} artifacts
   * @param {LH.Audit.Context} context
   * @return {Promise<LH.Audit.Product>}
   */
  static async audit(artifacts, context) {
    /** @type {TreemapData} */
    const treemapData = await TreemapDataAudit.makeRootNodes(artifacts, context);

    // TODO: when out of experimental should make a new detail type.
    /** @type {LH.Audit.Details.DebugData} */
    const details = {
      type: 'debugdata',
      treemapData,
    };

    return {
      score: 1,
      details,
    };
  }
}

module.exports = TreemapDataAudit;
