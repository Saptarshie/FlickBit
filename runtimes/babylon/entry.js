/**
 * Babylon runtime entry.
 *
 * The UMD build of Babylon is 8.7 MB — unusable for a card in a feed. This entry
 * is the tree-shaken alternative: it imports exactly the modules a 2.5D/3D
 * mini-game needs and exposes them as the familiar `window.BABYLON` namespace, so
 * generated code looks like ordinary Babylon code.
 *
 * Rule of thumb: everything imported here is paid for by every 3D game, so this
 * list is curated, not exhaustive. Adding a module is a decision with a byte cost
 * (see docs/development_docs/runtimes.md).
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3, Vector2, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Scalar } from '@babylonjs/core/Maths/math.scalar';
import { Space } from '@babylonjs/core/Maths/math.axis';

// Side-effect imports: scene components the mesh/material API expects to exist.
import '@babylonjs/core/Materials/standardMaterial';
import '@babylonjs/core/Rendering/depthRendererSceneComponent';
import '@babylonjs/core/Meshes/Builders/boxBuilder';
import '@babylonjs/core/Meshes/Builders/sphereBuilder';
import '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import '@babylonjs/core/Meshes/Builders/planeBuilder';
import '@babylonjs/core/Meshes/Builders/groundBuilder';
import '@babylonjs/core/Meshes/Builders/torusBuilder';
import '@babylonjs/core/Meshes/Builders/discBuilder';

const BABYLON = {
  Engine,
  Scene,
  FreeCamera,
  ArcRotateCamera,
  UniversalCamera,
  HemisphericLight,
  DirectionalLight,
  PointLight,
  MeshBuilder,
  Mesh,
  TransformNode,
  Vector3,
  Vector2,
  Matrix,
  Quaternion,
  Color3,
  Color4,
  StandardMaterial,
  Texture,
  Scalar,
  Space,
};

if (typeof window !== 'undefined') {
  window.BABYLON = BABYLON;
}

export default BABYLON;
