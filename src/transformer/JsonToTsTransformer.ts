import * as ts from "typescript";
import { cloneNode } from "ts-clone-node";
import {
  TWPropertyDefinition,
  TWBaseTypes,
  TWFieldAspects,
  TWServiceDefinition,
  TWEventDefinition,
  TWSubscriptionDefinition,
  TWThing,
  TWEntityDefinition,
  TWEntityKind,
  TWThingTemplate,
  TWDataShape,
  TWFieldBase,
  TWDataShapeField,
  TWConfigurationTableDefinition,
  TWConfigurationTableValue,
  TWVisibility,
  TWRuntimePermissionsList,
  TWRuntimePermissionDeclaration,
  TWPrincipal,
  TWThingShape,
  TWServiceParameter,
} from "./TWCoreTypes";
import { printNode } from "./tsUtils";

export interface TransformerOptions {
  /**
   * String to use to replace invalid characters in entity names
   * For example, in thingworx, a lot of entities have dots as separators.
   * This are, by default replaced with `_`
   */
  entityNameSeparator: string;
}

export class JsonThingToTsTransformer {
  private static DEFAULT_OPTIONS: TransformerOptions = {
    entityNameSeparator: "_",
  };
  private options: TransformerOptions;

  /**
   * Constructs a new transformer
   */
  constructor(options?: Partial<TransformerOptions>) {
    this.options = Object.assign(
      {},
      options,
      JsonThingToTsTransformer.DEFAULT_OPTIONS
    );
  }

  /**
   * Converts the json representation of a thingworx entity into a typescript class declaration, while its code as string
   * @param thingworxJson Thingworx json representation of an entity, exposed by thingworx through the metadata endpoint
   * @param entityKind Kind of entity to convert
   * @returns The actual entity class code, as well as the generated class name
   */
  public createTsDeclarationForEntity(
    thingworxJson: any,
    entityKind: TWEntityKind
  ): { declaration: string; className: string } {
    const parsedEntity = this.convertThingworxEntityDefinition(
      thingworxJson,
      entityKind
    );
    const tsClass = this.transformThingworxEntityToClass(parsedEntity);
    return {
      declaration: printNode(tsClass, true),
      className: tsClass.name?.text || "",
    };
  }

  /**
   * Transforms an entity definition into a typescript class declaration
   * This function expects a valid thingworx definition
   * @param entity Entity to transform
   * @returns the AST of the ClassDeclaration
   */
  public transformThingworxEntityToClass(
    entity: TWEntityDefinition
  ): ts.ClassDeclaration {
    const decorators: ts.Decorator[] = [];
    const modifiers: ts.Modifier[] = [];
    const heritage: ts.HeritageClause[] = [];
    const members: ts.ClassElement[] = [];
    // collect the names of properties and services that are defined directly on this entity
    const locallyDefinedNames = entity.propertyDefinitions
      .map((p) => p.name)
      .concat(entity.serviceDefinitions.map((s) => s.name));
    // set the exportName as the current entity name
    decorators.push(
      ts.factory.createDecorator(
        ts.factory.createCallExpression(
          ts.factory.createIdentifier("exportName"),
          undefined,
          [ts.factory.createStringLiteral(entity.name)]
        )
      )
    );
    if (entity.aspects?.isEditableExtensionObject) {
      decorators.push(
        ts.factory.createDecorator(ts.factory.createIdentifier("editable"))
      );
    }

    // ThingTemplates and things have a couple of things in common, like value streams
    if (
      entity.kind == TWEntityKind.ThingTemplate ||
      entity.kind == TWEntityKind.Thing
    ) {
      const template = entity as TWThingTemplate;
      if (template.valueStream) {
        decorators.push(
          ts.factory.createDecorator(
            ts.factory.createCallExpression(
              ts.factory.createIdentifier("valueStream"),
              undefined,
              [ts.factory.createStringLiteral(template.valueStream)]
            )
          )
        );
      }
      if (template.implementedShapes.length > 0) {
        heritage.push(
          ts.factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [
            ts.factory.createExpressionWithTypeArguments(
              ts.factory.createCallExpression(
                ts.factory.createIdentifier("ThingTemplateWithShapes"),
                undefined,
                [
                  ts.factory.createIdentifier(template.thingTemplate),
                  ...template.implementedShapes.map((s) =>
                    this.createIdentifierFromEntityName(s)
                  ),
                ]
              ),
              undefined
            ),
          ])
        );
      } else {
        heritage.push(
          ts.factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [
            ts.factory.createExpressionWithTypeArguments(
              ts.factory.createIdentifier(template.thingTemplate),
              undefined
            ),
          ])
        );
      }
    }
    // if it's a template, make sure that the decorator marking it's type is correctly set, as well as the instance visibility
    if (entity.kind == TWEntityKind.ThingTemplate) {
      const thingTemplate = entity as TWThingTemplate;
      decorators.push(
        ts.factory.createDecorator(
          ts.factory.createIdentifier("ThingTemplateDefinition")
        )
      );
      if (thingTemplate.instanceVisibilityPermissions.length > 0) {
        decorators.push(
          this.convertVisibilityToDecorator(
            thingTemplate.instanceVisibilityPermissions,
            "visibleInstance"
          )
        );
      }
    } else if (entity.kind == TWEntityKind.Thing) {
      const thing = entity as TWThing;
      decorators.push(
        ts.factory.createDecorator(
          ts.factory.createIdentifier("ThingDefinition")
        )
      );

      if (thing.published) {
        decorators.push(
          ts.factory.createDecorator(ts.factory.createIdentifier("published"))
        );
      }
      if (thing.identifier) {
        decorators.push(
          ts.factory.createDecorator(
            ts.factory.createCallExpression(
              ts.factory.createIdentifier("identifier"),
              undefined,
              [ts.factory.createNumericLiteral(thing.identifier)]
            )
          )
        );
      }
      // runtime permissions should always apply to services and properties that are defined directly on the entity
      // otherwise, they'll be directly on the service or property declarations
      Object.entries(thing.runtimePermissions)
        .filter(([k]) => !locallyDefinedNames.includes(k))
        .forEach(([k, p]) => {
          decorators.push(
            ...this.convertRuntimePermissionToDecorator(k, p, true)
          );
        });
    } else if (entity.kind == TWEntityKind.ThingShape) {
      heritage.push(
        ts.factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [
          ts.factory.createExpressionWithTypeArguments(
            ts.factory.createIdentifier("ThingShapeBase"),
            undefined
          ),
        ])
      );
    } else if (entity.kind == TWEntityKind.DataShape) {
      const dataShape = entity as TWDataShape;
      members.push(
        ...dataShape.fieldDefinitions.map((f) =>
          this.parseDataShapeFieldDefinition(f)
        )
      );
      heritage.push(
        ts.factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [
          ts.factory.createExpressionWithTypeArguments(
            ts.factory.createIdentifier("DataShapeBase"),
            undefined
          ),
        ])
      );
    }
    // thingShapes and thingTemplates have runtime permissions in common
    if (
      entity.kind == TWEntityKind.ThingShape ||
      entity.kind == TWEntityKind.ThingTemplate
    ) {
      const entityWithInstancePermissions = entity as TWThingShape;
      // instance permissions should always apply to services and properties that are defined directly on the entity
      // otherwise, they'll be directly on the service or property declarations
      Object.entries(entityWithInstancePermissions.instanceRuntimePermissions)
        .filter(([k]) => !locallyDefinedNames.includes(k))
        .forEach(([k, p]) => {
          decorators.push(
            ...this.convertRuntimePermissionToDecorator(k, p, true, true)
          );
        });
      // all runtime permissions get set directly on the class
      Object.entries(entityWithInstancePermissions.runtimePermissions).forEach(
        ([k, p]) => {
          decorators.push(
            ...this.convertRuntimePermissionToDecorator(k, p, true, false)
          );
        }
      );
    }
    if (entity.visibilityPermissions.length > 0) {
      decorators.push(
        this.convertVisibilityToDecorator(
          entity.visibilityPermissions,
          "visible"
        )
      );
    }
    if (entity.configurationTableDefinitions.length > 0) {
      decorators.push(
        this.createConfigurationTableDefinition(
          entity.configurationTableDefinitions
        )
      );
    }
    if (Object.keys(entity.configurationTables).length > 0) {
      decorators.push(
        this.createConfigurationTables(entity.configurationTables)
      );
    }
    if (
      ![
        TWEntityKind.Thing,
        TWEntityKind.ThingShape,
        TWEntityKind.ThingTemplate,
      ].includes(entity.kind)
    ) {
      // all runtime permissions get set directly on the class on all entities that are not Things, TS or TT
      Object.entries(entity.runtimePermissions).forEach(([k, p]) => {
        decorators.push(
          ...this.convertRuntimePermissionToDecorator(k, p, true)
        );
      });
    }
    // on templates and shape, permissions are in fact runtime instance permissions, otherwise they are runtime permissions
    const instancePermissions: TWRuntimePermissionsList =
      entity.kind == TWEntityKind.ThingShape ||
      entity.kind == TWEntityKind.ThingTemplate
        ? (entity as any).instanceRuntimePermissions
        : entity.runtimePermissions;

    // handle property, service, events and subscriptions
    members.push(
      ...entity.propertyDefinitions.map((p) =>
        this.convertPropertyDefinition(
          p,
          undefined,
          instancePermissions[p.name]
        )
      )
    );
    members.push(
      ...entity.serviceDefinitions.map((s) =>
        this.convertServiceDefinition(s, instancePermissions[s.name])
      )
    );
    members.push(
      ...entity.eventDefinitions.map((e) =>
        this.convertEventDefinition(e, instancePermissions[e.name])
      )
    );
    members.push(
      ...entity.subscriptionDefinitions.map((s) =>
        this.convertSubscriptionDefinition(s)
      )
    );

    const classDeclaration = ts.factory.createClassDeclaration(
      decorators,
      modifiers,
      this.createIdentifierFromEntityName(entity.name),
      undefined,
      heritage,
      members
    );
    // only add jsdoc on the property, if description exists
    if (entity.description) {
      return ts.addSyntheticLeadingComment(
        classDeclaration,
        ts.SyntaxKind.MultiLineCommentTrivia,
        this.commentize(entity.description),
        true
      );
    } else {
      return classDeclaration;
    }
  }

  /**
   * Transforms a Thingworx property definition entity into a typescript class property definition.
   *
   * @param propertyDefinition Property definition on the native Thingworx format
   * @param currentValue Current value of the property in Thingworx
   * @param permission Permission that applies to this property definition
   * @returns Typescript definition of the Property
   */
  public convertPropertyDefinition(
    propertyDefinition: TWPropertyDefinition,
    currentValue?: any,
    permissions?: TWRuntimePermissionDeclaration
  ): ts.PropertyDeclaration {
    const data = this.parseFieldDefinition(propertyDefinition);
    const decorators: ts.Decorator[] = [];
    const modifiers: ts.Modifier[] = [];
    // handle the `isPersistent` aspect that maps directly into an decorator
    if (propertyDefinition.aspects.isPersistent) {
      decorators.push(
        ts.factory.createDecorator(ts.factory.createIdentifier("persistent"))
      );
    }
    // handle the `isLogged` aspect that maps directly into an decorator
    if (propertyDefinition.aspects.isLogged) {
      decorators.push(
        ts.factory.createDecorator(ts.factory.createIdentifier("logged"))
      );
    }
    // handle the `dataChangeType` aspect that maps directly into an decorator with two parameters
    if (propertyDefinition.aspects.dataChangeType) {
      const decoratorArguments: ts.Expression[] = [
        ts.factory.createStringLiteral(
          propertyDefinition.aspects.dataChangeType
        ),
      ];
      if (propertyDefinition.aspects.dataChangeThreshold != undefined) {
        decoratorArguments.push(
          ts.factory.createNumericLiteral(
            propertyDefinition.aspects.dataChangeThreshold
          )
        );
      }
      decorators.push(
        ts.factory.createDecorator(
          ts.factory.createCallExpression(
            ts.factory.createIdentifier("dataChangeType"),
            undefined,
            decoratorArguments
          )
        )
      );
    }
    // handle the `isRemote` aspect that maps directly into an decorator with parameters. A corresponding `remoteBinding` property must exist on the propertyDefinition
    // todo: handle the kepware specific decorators. This are currently not supported in the reverse conversion
    // an idea would be to inject the remote binding information directly here
    if (
      propertyDefinition.aspects.isRemote &&
      propertyDefinition.remoteBinding
    ) {
      const remoteArgs: ts.ObjectLiteralElementLike[] = [];
      const handledRemoteBindingKeys = [
        "pushType",
        "pushThreshold",
        "startType",
        "foldType",
        "cacheTime",
        "timeout",
      ];
      // the source name is either present in the remote binding definition, or the name of the property itself
      const remoteSourceName =
        propertyDefinition.remoteBinding.sourceName || propertyDefinition.name;
      for (const key in propertyDefinition.remoteBinding) {
        if (handledRemoteBindingKeys.indexOf(key) != -1) {
          remoteArgs.push(
            ts.factory.createPropertyAssignment(
              key,
              this.createNodeLiteral(propertyDefinition.remoteBinding[key])
            )
          );
        }
      }

      const remoteDecorator = ts.factory.createDecorator(
        ts.factory.createCallExpression(
          ts.factory.createIdentifier("remote"),
          undefined,
          [
            ts.factory.createStringLiteral(remoteSourceName),
            ts.factory.createObjectLiteralExpression(remoteArgs),
          ]
        )
      );
      decorators.push(remoteDecorator);
    }
    // handle the local binding metadata. This maps into a decorator with two parameters
    if (propertyDefinition.localBinding) {
      const remoteDecorator = ts.factory.createDecorator(
        ts.factory.createCallExpression(
          ts.factory.createIdentifier("local"),
          undefined,
          [
            ts.factory.createStringLiteral(
              propertyDefinition.localBinding.sourceThingName
            ),
            ts.factory.createStringLiteral(
              propertyDefinition.localBinding.sourceName
            ),
          ]
        )
      );
      decorators.push(remoteDecorator);
    }
    if (permissions) {
      decorators.push(
        ...this.convertRuntimePermissionToDecorator(
          propertyDefinition.name,
          permissions,
          false,
          false
        )
      );
    }
    if (propertyDefinition.aspects.isReadOnly) {
      modifiers.push(ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword));
    }
    const initializerValue =
      currentValue || propertyDefinition.aspects.defaultValue;

    return ts.factory.updatePropertyDeclaration(
      data,
      (data.decorators || ([] as ts.Decorator[])).concat(decorators),
      (data.modifiers || ([] as ts.Modifier[])).concat(modifiers),
      data.name,
      initializerValue
        ? undefined
        : ts.factory.createToken(ts.SyntaxKind.ExclamationToken),
      data.type,
      initializerValue && this.createNodeLiteral(initializerValue)
    );
  }

  /**
   * Transforms a Thingworx datashape field definition entity into a typescript class property definition.
   *
   * @param propertyDefinition Parameter definition on the native Thingworx format
   * @returns Typescript definition of the parameter
   */
  public parseDataShapeFieldDefinition(
    propertyDefinition: TWDataShapeField
  ): ts.PropertyDeclaration {
    const data = this.parseFieldDefinition(propertyDefinition);
    const decorators: ts.Decorator[] = [];
    // handle the `primaryKey` aspect that maps directly into an decorator
    if (propertyDefinition.aspects.isPrimaryKey) {
      decorators.push(
        ts.factory.createDecorator(ts.factory.createIdentifier("primaryKey"))
      );
    }
    return ts.factory.updatePropertyDeclaration(
      data,
      (data.decorators || ([] as ts.Decorator[])).concat(decorators),
      data.modifiers,
      data.name,
      data.exclamationToken,
      data.type,
      data.initializer
    );
  }

  /**
   * Transforms a Thingworx field base data into a typescript property declaration.
   * This function contains the common code between thing properties and datashape fields
   *
   * @param fieldDefinition Field definition on the native Thingworx format
   * @returns Typescript definition of the field
   */
  private parseFieldDefinition(
    fieldDefinition: TWFieldBase
  ): ts.PropertyDeclaration {
    const decorators: ts.Decorator[] = [];
    const modifiers: ts.Modifier[] = [];
    // handle the `minimumValue` aspect that maps directly into an decorator with a single param
    if (fieldDefinition.aspects.minimumValue) {
      decorators.push(
        ts.factory.createDecorator(
          ts.factory.createCallExpression(
            ts.factory.createIdentifier("minimumValue"),
            undefined,
            [
              ts.factory.createNumericLiteral(
                fieldDefinition.aspects.minimumValue
              ),
            ]
          )
        )
      );
    }
    // handle the `maximumValue` aspect that maps directly into an decorator with a single param
    if (fieldDefinition.aspects.maximumValue) {
      decorators.push(
        ts.factory.createDecorator(
          ts.factory.createCallExpression(
            ts.factory.createIdentifier("maximumValue"),
            undefined,
            [
              ts.factory.createNumericLiteral(
                fieldDefinition.aspects.maximumValue
              ),
            ]
          )
        )
      );
    }
    // handle the `units` aspect that maps directly into an decorator with a single param
    if (fieldDefinition.aspects.units) {
      decorators.push(
        ts.factory.createDecorator(
          ts.factory.createCallExpression(
            ts.factory.createIdentifier("unit"),
            undefined,
            [ts.factory.createStringLiteral(fieldDefinition.aspects.units)]
          )
        )
      );
    }
    const initializerValue = fieldDefinition.aspects.defaultValue;

    const propertyDeclaration = ts.factory.createPropertyDeclaration(
      decorators,
      modifiers,
      fieldDefinition.name,
      initializerValue
        ? undefined
        : ts.factory.createToken(ts.SyntaxKind.ExclamationToken),
      this.getTypeNodeFromBaseType(
        fieldDefinition.baseType,
        fieldDefinition.aspects
      ),
      initializerValue && this.createNodeLiteral(initializerValue)
    );
    // only add jsdoc on the property, if description exists
    if (fieldDefinition.description) {
      return ts.addSyntheticLeadingComment(
        propertyDeclaration,
        ts.SyntaxKind.MultiLineCommentTrivia,
        this.commentize(fieldDefinition.description),
        true
      );
    } else {
      return propertyDeclaration;
    }
  }

  /**
   * Transforms a Thingworx service definition entity into a typescript class method definition.
   *
   * @param serviceDefinition Service definition on the native Thingworx format
   * @param permission Permission that applies to this service
   * @returns Method definition of the service
   */
  public convertServiceDefinition(
    serviceDefinition: TWServiceDefinition,
    permission?: TWRuntimePermissionDeclaration
  ): ts.MethodDeclaration {
    const decorators: ts.Decorator[] = [];
    const modifiers: ts.Modifier[] = [];

    // all async services transform into async methods
    if (serviceDefinition.aspects.isAsync) {
      modifiers.push(ts.factory.createModifier(ts.SyntaxKind.AsyncKeyword));
    }
    // all services that are not overridable get marked as final
    if (!serviceDefinition.isAllowOverride) {
      decorators.push(
        ts.factory.createDecorator(ts.factory.createIdentifier("final"))
      );
    }
    // all services that override a parent implementation should have a annotation
    if (serviceDefinition.isOverriden) {
      decorators.push(
        ts.factory.createDecorator(ts.factory.createIdentifier("override"))
      );
    }
    // remote services map into methods with empty bodies, and a decorator @remoteService
    if (serviceDefinition.remoteBinding) {
      const remoteArgs: ts.ObjectLiteralElementLike[] = [];

      if (serviceDefinition.remoteBinding.enableQueue) {
        remoteArgs.push(
          ts.factory.createPropertyAssignment(
            "enableQueue",
            ts.factory.createTrue()
          )
        );
      }
      if (serviceDefinition.remoteBinding.timeout != undefined) {
        remoteArgs.push(
          ts.factory.createPropertyAssignment(
            "timeout",
            ts.factory.createNumericLiteral(
              serviceDefinition.remoteBinding.timeout
            )
          )
        );
      }
      const remoteSourceName =
        serviceDefinition.remoteBinding.sourceName || serviceDefinition.name;

      const remoteDecorator = ts.factory.createDecorator(
        ts.factory.createCallExpression(
          ts.factory.createIdentifier("remoteService"),
          undefined,
          [
            ts.factory.createStringLiteral(remoteSourceName),
            ts.factory.createObjectLiteralExpression(remoteArgs),
          ]
        )
      );
      decorators.push(remoteDecorator);
    }
    // remote services should have an empty body
    const methodBody = serviceDefinition.remoteBinding
      ? ts.factory.createBlock([], false)
      : this.getTypescriptCodeFromBody(
          serviceDefinition.code,
          serviceDefinition.resultType.baseType
        );

    // handle the inputs of the service. This requires creating an object as well as an interface that defines it
    const tsParameters: ts.ParameterDeclaration[] = [];
    if (serviceDefinition.parameterDefinitions.length > 0) {
      const parameters: ts.ObjectBindingPattern =
        ts.factory.createObjectBindingPattern(
          serviceDefinition.parameterDefinitions.map((p) =>
            ts.factory.createBindingElement(
              undefined,
              undefined,
              p.name,
              p.aspects.defaultValue &&
                this.createNodeLiteral(p.aspects.defaultValue)
            )
          )
        );
      const parametersDef: ts.TypeLiteralNode =
        ts.factory.createTypeLiteralNode(
          serviceDefinition.parameterDefinitions.map((p) =>
            ts.factory.createPropertySignature(
              undefined,
              p.name,
              p.aspects.isRequired
                ? undefined
                : ts.factory.createToken(ts.SyntaxKind.QuestionToken),
              this.getTypeNodeFromBaseType(p.baseType, p.aspects)
            )
          )
        );
      tsParameters.push(
        ts.factory.createParameterDeclaration(
          undefined,
          undefined,
          undefined,
          parameters,
          undefined,
          parametersDef,
          undefined
        )
      );
    }
    if (permission) {
      decorators.push(
        ...this.convertRuntimePermissionToDecorator(
          serviceDefinition.name,
          permission,
          false,
          false
        )
      );
    }

    const methodDeclaration = ts.factory.createMethodDeclaration(
      decorators,
      modifiers,
      undefined,
      serviceDefinition.name,
      undefined,
      undefined,
      tsParameters,
      this.getTypeNodeFromBaseType(
        serviceDefinition.resultType.baseType,
        serviceDefinition.resultType.aspects
      ),
      methodBody
    );
    // only add jsdoc on the property, if description exists
    if (serviceDefinition.description) {
      return ts.addSyntheticLeadingComment(
        methodDeclaration,
        ts.SyntaxKind.MultiLineCommentTrivia,
        this.commentize(serviceDefinition.description),
        true
      );
    } else {
      return methodDeclaration;
    }
  }

  /**
   * Transforms a Thingworx subscription definition entity into a typescript class method definition.
   *
   * @param subscriptionDefinition subscription definition on the native Thingworx format
   * @returns Method definition of the subscription
   */
  public convertSubscriptionDefinition(
    subscriptionDefinition: TWSubscriptionDefinition
  ): ts.MethodDeclaration {
    const decorators: ts.Decorator[] = [];

    if (!subscriptionDefinition.enabled) {
      throw "Cannot handle disabled subscription definitions";
    }

    // if a source is specified, this means that this is a subscription for an event on another thing. If not, it's a local subscription
    if (subscriptionDefinition.source) {
      const subscriptionArgs: ts.Expression[] = [
        ts.factory.createStringLiteral(subscriptionDefinition.source),
        ts.factory.createStringLiteral(subscriptionDefinition.eventName),
      ];
      if (subscriptionDefinition.sourceProperty) {
        subscriptionArgs.push(
          ts.factory.createStringLiteral(subscriptionDefinition.sourceProperty)
        );
      }

      const subscriptionDecorator = ts.factory.createDecorator(
        ts.factory.createCallExpression(
          ts.factory.createIdentifier("subscription"),
          undefined,
          subscriptionArgs
        )
      );
      decorators.push(subscriptionDecorator);
    } else {
      const subscriptionArgs: ts.Expression[] = [
        ts.factory.createStringLiteral(subscriptionDefinition.eventName),
      ];
      if (subscriptionDefinition.sourceProperty) {
        subscriptionArgs.push(
          ts.factory.createStringLiteral(subscriptionDefinition.sourceProperty)
        );
      }

      const localSubscriptionDecorator = ts.factory.createDecorator(
        ts.factory.createCallExpression(
          ts.factory.createIdentifier("localSubscription"),
          undefined,
          subscriptionArgs
        )
      );
      decorators.push(localSubscriptionDecorator);
    }
    // subscriptions always return NOTHING
    const methodBody = this.getTypescriptCodeFromBody(
      subscriptionDefinition.code,
      "NOTHING"
    );

    // handle the inputs of the subscription. This parameters are static, with the exception of the event datashape
    // todo: Figure out a way of determining the event datashape that this subscription is based on, as right now we assume it's the name of the event + the suffix `Event`
    const genericParams = {
      alertName: this.getTypeNodeFromBaseType("STRING"),
      eventData: this.getTypeNodeFromBaseType("INFOTABLE", {
        dataShape: subscriptionDefinition.eventName + "Event",
      }),
      eventName: this.getTypeNodeFromBaseType("STRING"),
      eventTime: this.getTypeNodeFromBaseType("DATETIME"),
      source: this.getTypeNodeFromBaseType("STRING"),
      sourceProperty: this.getTypeNodeFromBaseType("STRING"),
    };

    const tsParameters = Object.entries(genericParams).map((p) =>
      ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        undefined,
        p[0],
        undefined,
        p[1],
        undefined
      )
    );

    const methodDeclaration = ts.factory.createMethodDeclaration(
      decorators,
      undefined,
      undefined,
      subscriptionDefinition.name,
      undefined,
      undefined,
      tsParameters,
      ts.factory.createToken(ts.SyntaxKind.VoidKeyword),
      methodBody
    );
    // only add jsdoc on the property, if description exists
    if (subscriptionDefinition.description) {
      return ts.addSyntheticLeadingComment(
        methodDeclaration,
        ts.SyntaxKind.MultiLineCommentTrivia,
        this.commentize(subscriptionDefinition.description),
        true
      );
    } else {
      return methodDeclaration;
    }
  }

  /**
   * Transforms a Thingworx event definition entity into a typescript class property definition with the type EVENT.
   *
   * @param eventDefinition Event definition on the native Thingworx format
   * @param permission Permission that applies to this event definition
   * @returns Property definition of the event
   */
  public convertEventDefinition(
    eventDefinition: TWEventDefinition,
    permission?: TWRuntimePermissionDeclaration
  ): ts.PropertyDeclaration {
    const decorators: ts.Decorator[] = [];

    // remote events have a remoteBinding set that gets converted into a decorator
    if (eventDefinition.remoteBinding) {
      const remoteDecorator = ts.factory.createDecorator(
        ts.factory.createCallExpression(
          ts.factory.createIdentifier("remoteEvent"),
          undefined,
          [
            ts.factory.createStringLiteral(
              eventDefinition.remoteBinding.sourceName
            ),
          ]
        )
      );
      decorators.push(remoteDecorator);
    }

    if (permission) {
      decorators.push(
        ...this.convertRuntimePermissionToDecorator(
          eventDefinition.name,
          permission,
          false,
          false
        )
      );
    }

    const propertyDeclaration = ts.factory.createPropertyDeclaration(
      decorators,
      undefined,
      eventDefinition.name,
      ts.factory.createToken(ts.SyntaxKind.ExclamationToken),
      // the type is an event with the datashape provided as a type argument
      ts.factory.createTypeReferenceNode("EVENT", [
        ts.factory.createTypeReferenceNode(eventDefinition.dataShape),
      ]),
      undefined
    );
    // only add jsdoc on the property, if description exists
    if (eventDefinition.description) {
      return ts.addSyntheticLeadingComment(
        propertyDeclaration,
        ts.SyntaxKind.MultiLineCommentTrivia,
        this.commentize(eventDefinition.description),
        true
      );
    } else {
      return propertyDeclaration;
    }
  }

  /**
   * Normalizes the JSON metadata of a entity into an object that the API expects
   * @param thingworxJson JSON definition of the object, as returned by the metadata endpoint
   * @param entityKind Type of entity to transform
   * @returns The normalized representation of the Thingworx entity
   */
  private convertThingworxEntityDefinition(
    thingworxJson: any,
    entityKind: TWEntityKind
  ): TWEntityDefinition {
    const definitionsSource =
      entityKind == TWEntityKind.Thing ||
      entityKind == TWEntityKind.ThingTemplate
        ? thingworxJson.thingShape
        : thingworxJson;
    const propertyDefinitions: TWPropertyDefinition[] = Object.entries(
      definitionsSource.propertyDefinitions || {}
    ).map(([k, v]) => {
      const result: TWPropertyDefinition = Object.assign({}, v as any);
      // information about the remote and local bindings are stored on separate top level properties
      // this brings them together into the same object
      result.remoteBinding = thingworxJson.remotePropertyBindings[k];
      result.localBinding = thingworxJson.propertyBindings[k];
      return result;
    });

    const serviceDefinitions: TWServiceDefinition[] = Object.entries(
      definitionsSource.serviceDefinitions || {}
    ).map(([k, v]) => {
      const result: TWServiceDefinition = Object.assign({}, v as any);
      // the actual service code (implementation) is stored in the serviceImplementation object
      if (definitionsSource.serviceImplementations[k]) {
        const handlerName =
          definitionsSource.serviceImplementations[k].handlerName;
        if (handlerName != "Script") {
          throw `Service implementation for service "${k}" has the handler set to "${handlerName}". This is not supported.`;
        }
        result.code =
          definitionsSource.serviceImplementations[
            k
          ].configurationTables.Script.rows[0].code;
      }
      // property definitions need to be represented as an array
      result.parameterDefinitions = Object.entries(
        (v as any).parameterDefinitions
      ).map(([k, v]) => v) as TWServiceParameter[];
      result.remoteBinding = thingworxJson.remoteServiceBindings[k];
      return result;
    });

    const subscriptionDefinitions: TWSubscriptionDefinition[] = Object.entries(
      definitionsSource.subscriptions || {}
    ).map(([k, v]) => {
      const result: TWSubscriptionDefinition = Object.assign({}, v as any);
      // subscription code is actually stored under the service implementation
      result.code = (
        v as any
      ).serviceImplementation.configurationTables.Script.rows[0].code;
      return result;
    });

    const eventDefinitions: TWEventDefinition[] = Object.entries(
      definitionsSource.eventDefinitions || {}
    ).map(([k, v]) => {
      const result: TWEventDefinition = Object.assign({}, v as any);
      result.remoteBinding = thingworxJson.remoteEventBindings[k];
      return result;
    });

    const configurationTableDefinitions: TWConfigurationTableDefinition[] =
      Object.entries(thingworxJson.configurationTableDefinitions || {}).map(
        ([k, v]) => v as TWConfigurationTableDefinition
      );

    // reduce the value of the configuration table by removing the infotable datashape information, and keeping only the rows
    const configurationTables: TWConfigurationTableValue = Object.entries(
      thingworxJson.configurationTables || {}
    ).reduce((obj, [k, v]) => {
      const table = v as any;
      if (table.isMultiRow) {
        return { ...obj, [k]: table.rows };
      } else {
        return { ...obj, [k]: table.rows[0] };
      }
    }, {});
    // runtimePermissions need to be indexed by the resource name
    const runtimePermissions: TWRuntimePermissionsList =
      thingworxJson.runTimePermissions.permissions.reduce(
        (obj, p) => ({ ...obj, [p.resourceName]: p }),
        {}
      );

    const baseEntity: TWEntityDefinition = {
      description: thingworxJson.description,
      documentationContent: thingworxJson.documentationContent,
      name: thingworxJson.name,
      project: thingworxJson.projectName,
      tags: thingworxJson.tags,
      aspects: thingworxJson.aspects,
      propertyDefinitions: propertyDefinitions,
      serviceDefinitions: serviceDefinitions,
      eventDefinitions: eventDefinitions,
      subscriptionDefinitions: subscriptionDefinitions,
      configurationTableDefinitions: configurationTableDefinitions,
      configurationTables: configurationTables,
      kind: entityKind,
      visibilityPermissions: thingworxJson.visibilityPermissions.Visibility,
      runtimePermissions: runtimePermissions,
    };

    if (entityKind == TWEntityKind.Thing) {
      return Object.assign(
        {
          enabled:
            thingworxJson.enabled === "true" || thingworxJson.enabled === true,
          identifier: thingworxJson.identifier,
          published: thingworxJson.published,
          valueStream: thingworxJson.valueStream,
          thingTemplate: thingworxJson.thingTemplate,
          implementedShapes: Object.keys(thingworxJson.implementedShapes),
        },
        baseEntity
      ) as TWThing;
    } else if (entityKind == TWEntityKind.ThingTemplate) {
      return Object.assign(
        {
          valueStream: thingworxJson.valueStream,
          thingTemplate: thingworxJson.baseThingTemplate,
          implementedShapes: Object.keys(thingworxJson.implementedShapes),
          instanceVisibilityPermissions:
            thingworxJson.instanceVisibilityPermissions.Visibility,
          instanceRuntimePermissions:
            thingworxJson.instanceRunTimePermissions.permissions.reduce(
              (obj, p) => ({ ...obj, [p.resourceName]: p }),
              {}
            ),
        },
        baseEntity
      ) as TWThingTemplate;
    } else if (entityKind == TWEntityKind.ThingShape) {
      return Object.assign(
        {
          instanceRuntimePermissions:
            thingworxJson.instanceRunTimePermissions.permissions.reduce(
              (obj, p) => ({ ...obj, [p.resourceName]: p }),
              {}
            ),
        },
        baseEntity
      );
    } else if (entityKind == TWEntityKind.DataShape) {
      return Object.assign(
        {
          fieldDefinitions: Object.entries(thingworxJson.fieldDefinitions).map(
            ([k, v]) => v as any
          ),
        },
        baseEntity
      ) as TWDataShape;
    } else {
      return baseEntity;
    }
  }
  /**
   * Constructs an decorator that can be applied to a thingworx class entity to describe the configuration table definitions
   * @param configurationTables List of configuration table definitions to be included
   * @returns typescript decorator describing the configuration table
   */
  private createConfigurationTableDefinition(
    configurationTables: TWConfigurationTableDefinition[]
  ): ts.Decorator {
    return ts.factory.createDecorator(
      ts.factory.createCallExpression(
        ts.factory.createIdentifier("ConfigurationTables"),
        undefined,
        [
          ts.factory.createClassExpression(
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            configurationTables.map((t) => {
              const memberDeclaration = ts.factory.createPropertyDeclaration(
                undefined,
                undefined,
                ts.factory.createIdentifier(t.name),
                undefined,
                ts.factory.createTypeReferenceNode(
                  ts.factory.createIdentifier(
                    t.isMultiRow ? "MultiRowTable" : "Table"
                  ),
                  [
                    ts.factory.createTypeReferenceNode(
                      ts.factory.createIdentifier(t.dataShapeName)
                    ),
                  ]
                ),
                undefined
              );
              if (t.description) {
                return ts.addSyntheticLeadingComment(
                  memberDeclaration,
                  ts.SyntaxKind.MultiLineCommentTrivia,
                  this.commentize(t.description),
                  true
                );
              } else {
                return memberDeclaration;
              }
            })
          ),
        ]
      )
    );
  }

  /**
   * Constructs an decorator that can be applied to a thingworx class entity to describe the configuration table values
   * @param configurationTables List of configuration table values
   * @returns typescript decorator describing the configuration table values
   */
  private createConfigurationTables(
    configurationTables: TWConfigurationTableValue
  ): ts.Decorator {
    return ts.factory.createDecorator(
      ts.factory.createCallExpression(
        ts.factory.createIdentifier("config"),
        undefined,
        [this.getTypescriptAstFromJson(configurationTables)]
      )
    );
  }

  /**
   * Converts and adapts the code of a service or subscription in ThingWorx into the body of a typescript method
   * This handles converting of the `me` references into `this` references, as well making sure the method actually returns
   *
   * @param thingworxCode Code declared in thingworx under a service or subscription
   * @param resultType Result type of the service
   * @returns Code adapted for use in typescript
   */
  private getTypescriptCodeFromBody(
    thingworxCode: string,
    resultType: keyof typeof TWBaseTypes
  ): ts.FunctionBody {
    const FUNCTION_PREFIX = "var result = (function () {";
    const FUNCTION_SUFFIX = "})()";
    const FUNCTION_SUFFIX_WITH_APPLY = "}).apply(me)";
    // test if this service is a immediately invoked function, as emitted by the ts->xml transformer
    if (
      thingworxCode.startsWith(FUNCTION_PREFIX) &&
      thingworxCode.endsWith(FUNCTION_SUFFIX)
    ) {
      thingworxCode = thingworxCode.slice(
        FUNCTION_PREFIX.length,
        thingworxCode.length - FUNCTION_SUFFIX.length
      );
    } else if (
      thingworxCode.startsWith(FUNCTION_PREFIX) &&
      thingworxCode.endsWith(FUNCTION_SUFFIX_WITH_APPLY)
    ) {
      thingworxCode = thingworxCode.slice(
        FUNCTION_PREFIX.length,
        thingworxCode.length - FUNCTION_SUFFIX_WITH_APPLY.length
      );
    } else if (resultType != "NOTHING") {
      // otherwise, just expect to return the result at the end
      thingworxCode += "\nreturn result;";
    }
    const sourceFile = ts.createSourceFile(
      "code.ts",
      `${thingworxCode}`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    // Typescript transformer that transforms me. or me[''] into this. and this['']
    const typeMeToThisTransformer: ts.TransformerFactory<ts.Node> = (
      context
    ) => {
      const visit: ts.Visitor = (node: ts.Node) => {
        node = ts.visitEachChild(node, visit, context);
        // todo: also transform all functions into arrow functions, in order to avoid issues where this will end up referring to the wrong object
        if (ts.isPropertyAccessExpression(node)) {
          if (
            ts.isIdentifier(node.expression) &&
            node.expression.escapedText == "me"
          ) {
            return ts.factory.createPropertyAccessExpression(
              ts.factory.createThis(),
              node.name
            );
          }
        } else if (ts.isElementAccessExpression(node)) {
          if (
            ts.isIdentifier(node.expression) &&
            node.expression.escapedText == "me"
          ) {
            return ts.factory.createElementAccessExpression(
              ts.factory.createThis(),
              node.argumentExpression
            );
          }
        }
        return node;
      };

      return (node: ts.Node): ts.Node => ts.visitNode(node, visit);
    };

    // Run code through the transformer above
    const result = ts.transform(sourceFile, [typeMeToThisTransformer])
      .transformed[0] as ts.SourceFile;

    // create a block using the statements in the parsed source file above.
    // it's highly important that we clone the statements. That is because typescript doesn't really support merging two different ASTs
    // (see https://stackoverflow.com/questions/69028643/how-to-merge-two-typescript-asts)
    // by leveraging the ts-clone-node library, we ensure that the ast of the service is cloned, so the parent links, as well as the
    // start and end position of each node are reset
    // additionally the ts-clone-node library also transforms the comment ranges into synthetic comments, ensuring that comments are preserved
    // (see https://github.com/wessberg/ts-clone-node/blob/master/src/clone-node/util/preserve-comments.ts)
    return ts.factory.createBlock(
      result.statements.map((t) => cloneNode(t)),
      true
    );
  }

  /**
   * Converts an json object into typescript AST
   *
   * @param object Object to be converted. This is treated as a JSON object, so it should only represent data
   * @returns Typescript AST represented as a ObjectLiteralExpression
   */
  private getTypescriptAstFromJson(
    object: unknown
  ): ts.ObjectLiteralExpression {
    const sourceFile = ts.createSourceFile(
      "code.json",
      JSON.stringify(object),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JSON
    );

    // the source file will contain one statement, and inside it, an ObjectLiteralExpression
    if (!ts.isObjectLiteralExpression(sourceFile.statements[0].getChildAt(0))) {
      throw "Data cannot be parsed as a typescript ObjectLiteralExpression";
    }
    return cloneNode(
      sourceFile.statements[0].getChildAt(0)
    ) as ts.ObjectLiteralExpression;
  }

  /**
   * Converts a list of visibilities of a Thingworx entities into a decorator
   *
   * @param visibilities Visibility list to generate
   * @returns A decorator for the visibility declaration
   */
  private convertVisibilityToDecorator(
    visibilities: TWVisibility[],
    decoratorName: string
  ): ts.Decorator {
    const visibilityArguments = visibilities.map((v) => {
      if (v.type == "Organization") {
        return ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier("Organizations"),
          ts.factory.createIdentifier(v.name)
        );
      } else if (v.type == "OrganizationalUnit") {
        return ts.factory.createCallExpression(
          ts.factory.createIdentifier("Unit"),
          undefined,
          [
            ts.factory.createPropertyAccessExpression(
              ts.factory.createIdentifier("Organizations"),
              ts.factory.createIdentifier(v.name.split(":")[0])
            ),
            ts.factory.createStringLiteral(v.name.split(":")[1]),
          ]
        );
      } else {
        throw `Invalid visibility type '${v.type}'`;
      }
    });
    return ts.factory.createDecorator(
      ts.factory.createCallExpression(
        ts.factory.createIdentifier(decoratorName),
        undefined,
        visibilityArguments
      )
    );
  }

  /**
   * Converts a runtime permission into a typescript decorator.
   *
   * @param resourceName Name of the resource this permission applies to
   * @param permissions Permissions to apply to this resource
   * @param resourceNameExplicit Whether the resource name should be included in the decorator declaration
   * @param instancePermission If this permission applies to an instance of this thingShape/thingTemplate or applies to the entity itself
   * @returns A decorator for the visibility declaration
   */
  private convertRuntimePermissionToDecorator(
    resourceName: string,
    permissions: TWRuntimePermissionDeclaration,
    resourceNameExplicit = false,
    instancePermission = false
  ): ts.Decorator[] {
    // list of all of the runtime permissions permitted in thingworx. This map directly to keys of the Permission enum
    const PERMISSION_TYPES = [
      "PropertyRead",
      "PropertyWrite",
      "ServiceInvoke",
      "EventInvoke",
      "EventSubscribe",
    ];

    const allowArguments: ts.Expression[] = [];
    const denyArguments: ts.Expression[] = [];
    const convertPrincipalToReference = (
      p: TWPrincipal
    ): ts.PropertyAccessExpression =>
      ts.factory.createPropertyAccessExpression(
        // the only valid values here are 'User' and 'Group', so this just makes them plural
        ts.factory.createIdentifier(p.type + "s"),
        ts.factory.createIdentifier(p.name)
      );
    for (const permissionType of PERMISSION_TYPES) {
      if (permissions[permissionType].length > 0) {
        const allowPermissions = permissions[permissionType].filter(
          (p) => p.isPermitted
        );
        const denyPermissions = permissions[permissionType].filter(
          (p) => !p.isPermitted
        );
        allowArguments.push(
          ...allowPermissions.map(convertPrincipalToReference)
        );
        denyArguments.push(...denyPermissions.map(convertPrincipalToReference));
        // if any allow permissions were detected, then add the permission type to this argument list
        if (allowPermissions.length > 0) {
          // add at the start, to group nicely together all the permissions.
          allowArguments.unshift(
            ts.factory.createPropertyAccessExpression(
              ts.factory.createIdentifier("Permission"),
              ts.factory.createIdentifier(permissionType)
            )
          );
        }
        // if any deny permissions were detected, then add the permission type to this argument list
        if (denyPermissions.length > 0) {
          denyArguments.unshift(
            ts.factory.createPropertyAccessExpression(
              ts.factory.createIdentifier("Permission"),
              ts.factory.createIdentifier(permissionType)
            )
          );
        }
      }
    }

    // only include the resource name as the first argument if a value is actually provided (it's not '*') or we are on the node directly
    if (resourceName != "*" && resourceNameExplicit) {
      allowArguments.unshift(ts.factory.createStringLiteral(resourceName));
      denyArguments.unshift(ts.factory.createStringLiteral(resourceName));
    }

    const result: ts.Decorator[] = [];
    // if at least two arguments are in the allow or deny arguments list (at minimum a permission and a principal), then create a decorator
    if (allowArguments.length > 1) {
      result.push(
        ts.factory.createDecorator(
          ts.factory.createCallExpression(
            ts.factory.createIdentifier(
              instancePermission ? "allowInstance" : "allow"
            ),
            undefined,
            allowArguments
          )
        )
      );
    }
    if (denyArguments.length > 1) {
      result.push(
        ts.factory.createDecorator(
          ts.factory.createCallExpression(
            ts.factory.createIdentifier(
              instancePermission ? "denyInstance" : "deny"
            ),
            undefined,
            denyArguments
          )
        )
      );
    }

    return result;
  }

  /**
   * Obtains the typescript type reference from a given thingworx basetype.
   * * For most basetypes, this is a direct mapping.
   * * For INFOTABLE, use a typeArgument of the datashape (if it exists)
   * * For THINGNAME and THINGTEMPLATENAME, be able to reference a referencing ThingTemplate or ThingShape
   *
   * @param baseTypeName Thingworx basetype name
   * @param aspects field aspects containing information about used datashapes or thingtemplate
   * @returns A ts type reference
   */
  private getTypeNodeFromBaseType(
    baseTypeName: keyof typeof TWBaseTypes,
    aspects?: TWFieldAspects<unknown>
  ): ts.TypeReferenceNode {
    const typeArguments: ts.TypeNode[] = [];
    if (baseTypeName == TWBaseTypes.INFOTABLE && aspects?.dataShape) {
      typeArguments.push(ts.factory.createTypeReferenceNode(aspects.dataShape));
    }
    if (
      baseTypeName == TWBaseTypes.THINGNAME ||
      baseTypeName == TWBaseTypes.THINGTEMPLATENAME
    ) {
      if (aspects && aspects.thingTemplate && aspects.thingShape) {
        typeArguments.push(
          ts.factory.createTypeReferenceNode(aspects.thingTemplate)
        );
        typeArguments.push(
          ts.factory.createTypeReferenceNode(aspects.thingShape)
        );
      } else if (aspects?.thingTemplate) {
        typeArguments.push(
          ts.factory.createTypeReferenceNode(aspects.thingTemplate)
        );
      } else if (aspects?.thingShape) {
        typeArguments.push(ts.factory.createToken(ts.SyntaxKind.AnyKeyword));
        typeArguments.push(
          ts.factory.createTypeReferenceNode(aspects.thingShape)
        );
      }
    }
    // to avoid confusion between the existing JSON type and the thingworx json, apply a special mapping
    if (baseTypeName == TWBaseTypes.JSON) {
      return ts.factory.createTypeReferenceNode("TWJSON");
    } else {
      return ts.factory.createTypeReferenceNode(baseTypeName, typeArguments);
    }
  }

  /**
   * Wraps a given text in JSDoc-like comments
   * @param contents String to include in comments
   * @returns wrapped text
   */
  private commentize(contents: string): string {
    return `*\n * ${contents.replace(/\n/g, "\n * ")}\n `;
  }

  /**
   * Utility function that creates the correct typescript literal for a js primitive
   * @param value Value to wrap in a literal
   * @returns typescript literal with that value
   */
  private createNodeLiteral = function createLiteral(
    value: string | number | boolean
  ): ts.PrimaryExpression {
    if (typeof value === "number") {
      return ts.factory.createNumericLiteral(value);
    }
    if (typeof value === "boolean") {
      return value ? ts.factory.createTrue() : ts.factory.createFalse();
    }
    if (typeof value === "string") {
      return ts.factory.createStringLiteral(value);
    }
    throw `Cannot convert to literal the type with value '${value}'`;
  };

  /**
   * Creates a valid typescript identifier based on a name
   * @param name Name of the thingworx entity
   * @returns a typescript identifier
   */
  private createIdentifierFromEntityName(name: string): ts.Identifier {
    const DISALLOWED_ENTITY_CHARS = /^[^a-zA-Z_]+|[^a-zA-Z_0-9]+/g;
    const validName = name.replace(
      DISALLOWED_ENTITY_CHARS,
      this.options.entityNameSeparator
    );
    return ts.factory.createIdentifier(validName);
  }
}
