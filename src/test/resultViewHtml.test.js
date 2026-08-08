'use strict';

const vm = require('node:vm');
const packageJson = require('../../package.json');
const { createResultViewHtml } = require('../views/resultViewHtml');

describe('lower Results view', () => {
  it('generates valid JavaScript for the SQL result grid', () => {
    const html = createResultViewHtml('test-nonce');
    const match = html.match(
      /<script nonce="test-nonce">([\s\S]*?)<\/script>/,
    );

    expect(match).not.toBeNull();
    expect(() => new vm.Script(match[1])).not.toThrow();
    expect(match[1]).toContain("lines.join('\\n')");
    expect(html).toContain("numberCell.className = 'row-number'");
  });

  it('contributes Results as a webview in the VS Code Panel', () => {
    const panel = packageJson.contributes.viewsContainers.panel;
    const views = packageJson.contributes.views.simpleDbResults;

    expect(packageJson.version).toBe('0.1.6');
    expect(panel).toContainEqual(
      expect.objectContaining({ id: 'simpleDbResults', title: 'Simple DB' }),
    );
    expect(views).toContainEqual(
      expect.objectContaining({ id: 'simpleDb.results', type: 'webview' }),
    );
  });

  it('renders SELECT metadata and returned rows in the lower grid', () => {
    class FakeElement {
      constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.dataset = {};
        this.listeners = {};
        this.className = '';
        this.textContent = '';
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.max = '';
        this.classList = { toggle: () => {} };
      }

      appendChild(child) {
        this.children.push(child);
        return child;
      }

      replaceChildren(...children) {
        this.children = children;
      }

      addEventListener(type, listener) {
        this.listeners[type] = listener;
      }

      querySelectorAll() {
        return [];
      }
    }

    const elements = new Map();
    const document = {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new FakeElement());
        return elements.get(id);
      },
      createElement(tagName) {
        return new FakeElement(tagName);
      },
      querySelectorAll() {
        return [];
      },
    };
    const windowListeners = {};
    const window = {
      addEventListener(type, listener) {
        windowListeners[type] = listener;
      },
    };
    const posted = [];
    const html = createResultViewHtml('render-test');
    const scriptSource = html.match(
      /<script nonce="render-test">([\s\S]*?)<\/script>/,
    )[1];
    const script = new vm.Script(scriptSource);

    script.runInNewContext({
      acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message) }),
      document,
      window,
    });

    expect(posted).toContainEqual({ type: 'ready' });
    windowListeners.message({
      data: {
        type: 'metadata',
        metadata: {
          connectionName: 'Local SQLite',
          totalRows: 1,
          affectedRows: 0,
          durationMs: 5,
          status: 'success',
          sets: [
            {
              kind: 'rows',
              rowCount: 1,
              pages: 1,
              columns: [
                { name: 'id', type: 'INTEGER' },
                { name: 'name', type: 'TEXT' },
              ],
            },
          ],
        },
      },
    });

    expect(posted).toContainEqual({ type: 'page', setIndex: 0, pageIndex: 0 });
    windowListeners.message({
      data: {
        type: 'pageData',
        setIndex: 0,
        pageIndex: 0,
        rowOffset: 0,
        rows: [[1, 'Ada']],
      },
    });

    const grid = elements.get('grid');
    const allNodes = [];
    const collect = (node) => {
      allNodes.push(node);
      node.children.forEach(collect);
    };
    grid.children.forEach(collect);
    expect(allNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ className: 'row-number', textContent: '1' }),
        expect.objectContaining({ tagName: 'TD', textContent: 'Ada' }),
      ]),
    );
    expect(elements.get('summary').textContent).toBe(
      'Local SQLite · 1 row · 5 ms',
    );
  });
});
