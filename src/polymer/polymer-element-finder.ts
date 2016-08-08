/**
 * @license
 * Copyright (c) 2015 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import * as estraverse from 'estraverse';
import * as estree from 'estree';

import {Analyzer} from '../analyzer';
import {Descriptor, EventDescriptor, PolymerElementDescriptor, PolymerProperty, Property} from '../ast/ast';
import * as astValue from '../javascript/ast-value';
import {Visitor} from '../javascript/estree-visitor';
import * as esutil from '../javascript/esutil';
import {JavaScriptDocument, getSourceLocation} from '../javascript/javascript-document';
import {JavaScriptEntityFinder} from '../javascript/javascript-entity-finder';
import * as jsdoc from '../javascript/jsdoc';

import * as analyzeProperties from './analyze-properties';
import {PropertyHandlers, declarationPropertyHandlers} from './declaration-property-handlers';
import * as docs from './docs';

export class PolymerElementFinder implements JavaScriptEntityFinder {
  async findEntities(
      document: JavaScriptDocument, visit: (visitor: Visitor) => Promise<void>):
      Promise<PolymerElementDescriptor[]> {
    let visitor = new ElementVisitor();
    await visit(visitor);
    return visitor.entities;
  }
}

class ElementVisitor implements Visitor {
  entities: PolymerElementDescriptor[] = [];

  /**
   * The element being built during a traversal;
   */
  element: PolymerElementDescriptor = null;
  propertyHandlers: PropertyHandlers = null;
  classDetected: boolean = false;

  enterClassDeclaration(node: estree.ClassDeclaration, parent: estree.Node) {
    this.classDetected = true;
    this.element = new PolymerElementDescriptor({
      description: esutil.getAttachedComment(node),
      events: esutil.getEventComments(node),
      sourceLocation: getSourceLocation(node)
    });
    this.propertyHandlers = declarationPropertyHandlers(this.element);
  }

  leaveClassDeclaration(node: estree.ClassDeclaration, parent: estree.Node) {
    this.element.properties.map((property) => docs.annotate(property));
    // TODO(justinfagnani): this looks wrong, class definitions can be nested
    // so a definition in a method in a Polymer() declaration would end the
    // declaration early. We should track which class induced the current
    // element and finish the element when leaving _that_ class.
    if (this.element) {
      docs.annotate(this.element);
      this.entities.push(this.element);
      this.element = null;
      this.propertyHandlers = null;
    }
    this.classDetected = false;
  }

  enterAssignmentExpression(
      node: estree.AssignmentExpression, parent: estree.Node) {
    if (!this.element) {
      return;
    }
    const left = <estree.MemberExpression>node.left;
    if (left && left.object && left.object.type !== 'ThisExpression') {
      return;
    }
    const prop = <estree.Identifier>left.property;
    if (prop && prop.name) {
      let name = prop.name;
      if (name in this.propertyHandlers) {
        this.propertyHandlers[name](node.right);
      }
    }
  }

  enterMethodDefinition(node: estree.MethodDefinition, parent: estree.Node) {
    if (!this.element) {
      return;
    }
    let prop = <estree.Property>{
      key: node.key,
      value: node.value,
      kind: node.kind,
      method: true,
      leadingComments: node.leadingComments,
      shorthand: false,
      computed: false,
      type: 'Property'
    };
    const propDesc = <Property>docs.annotate(esutil.toPropertyDescriptor(prop));
    if (prop && prop.kind === 'get' &&
        (propDesc.name === 'behaviors' || propDesc.name === 'observers')) {
      let returnStatement = <estree.ReturnStatement>node.value.body.body[0];
      let argument = <estree.ArrayExpression>returnStatement.argument;
      if (propDesc.name === 'behaviors') {
        argument.elements.forEach((elementNode) => {
          this.element.behaviors.push(astValue.getIdentifierName(elementNode));
        });
      } else {
        argument.elements.forEach((elementObject: estree.Literal) => {
          this.element.observers.push(
              {javascriptNode: elementObject, expression: elementObject.raw});
        });
      }
    } else {
      this.element.addProperty(propDesc);
    }
  }

  enterCallExpression(node: estree.CallExpression, parent: estree.Node) {
    // When dealing with a class, enterCallExpression is called after the
    // parsing actually starts
    if (this.classDetected) {
      return estraverse.VisitorOption.Skip;
    }

    let callee = node.callee;
    if (callee.type === 'Identifier') {
      if (callee.name === 'Polymer') {
        this.element = new PolymerElementDescriptor({
          description: esutil.getAttachedComment(parent),
          events: esutil.getEventComments(parent),
          sourceLocation: getSourceLocation(node.arguments[0])
        });
        docs.annotate(this.element);
        this.element.description = (this.element.description || '').trim();
        this.propertyHandlers = declarationPropertyHandlers(this.element);
      }
    }
  }

  leaveCallExpression(node: estree.CallExpression, parent: estree.Node) {
    let callee = node.callee;
    let args = node.arguments;
    if (callee.type === 'Identifier' && args.length === 1 &&
        args[0].type === 'ObjectExpression') {
      if (callee.name === 'Polymer') {
        if (this.element) {
          this.entities.push(this.element);
          this.element = null;
          this.propertyHandlers = null;
        }
      }
    }
  }

  enterObjectExpression(node: estree.ObjectExpression, parent: estree.Node) {
    // When dealing with a class, there is no single object that we can parse to
    // retrieve all properties
    if (this.classDetected) {
      return estraverse.VisitorOption.Skip;
    }

    // TODO(justinfagnani): is the second clause needed?
    if (this.element) {
      let getters: {[name: string]: PolymerProperty} = {};
      let setters: {[name: string]: PolymerProperty} = {};
      let definedProperties: {[name: string]: PolymerProperty} = {};
      for (let i = 0; i < node.properties.length; i++) {
        let prop = node.properties[i];
        let name = esutil.objectKeyToString(prop.key);
        if (!name) {
          throw {
            message: 'Cant determine name for property key.',
            location: node.loc.start
          };
        }

        if (name in this.propertyHandlers) {
          this.propertyHandlers[name](prop.value);
          continue;
        }
        let descriptor = esutil.toPropertyDescriptor(prop);
        if (descriptor.getter) {
          getters[descriptor.name] = descriptor;
        } else if (descriptor.setter) {
          setters[descriptor.name] = descriptor;
        } else {
          this.element.addProperty(esutil.toPropertyDescriptor(prop));
        }
      }
      Object.keys(getters).forEach((getter) => {
        let get = getters[getter];
        definedProperties[get.name] = get;
      });
      Object.keys(setters).forEach((setter) => {
        let set = setters[setter];
        if (!(set.name in definedProperties)) {
          definedProperties[set.name] = set;
        } else {
          definedProperties[set.name].setter = true;
        }
      });
      Object.keys(definedProperties).forEach((p) => {
        let prop = definedProperties[p];
        this.element.addProperty(prop);
      });
      return estraverse.VisitorOption.Skip;
    }
  }
}
