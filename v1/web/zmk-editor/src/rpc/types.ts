/**
 * Re-exports of the ZMK Studio RPC message types we use, so the rest of
 * the app imports keymap/behavior types from one place instead of
 * reaching into `@zmkfirmware/zmk-studio-ts-client/*` subpaths
 * everywhere.
 *
 * The wire protocol (protobuf framing over Web Serial / Web Bluetooth)
 * is entirely handled by the ts-client; we only touch these decoded
 * shapes. See `session.ts` for the typed call wrappers.
 */

export type {
  Notification,
  Request,
  RequestResponse,
  RpcConnection,
} from '@zmkfirmware/zmk-studio-ts-client';
export type {
  BehaviorBindingParametersSet,
  BehaviorParameterValueDescription,
  GetBehaviorDetailsResponse,
} from '@zmkfirmware/zmk-studio-ts-client/behaviors';
export type { GetDeviceInfoResponse } from '@zmkfirmware/zmk-studio-ts-client/core';
// LockState is a runtime enum (used as a value), so it is a normal export.
export { LockState } from '@zmkfirmware/zmk-studio-ts-client/core';
export type {
  AddLayerResponse,
  BehaviorBinding,
  Keymap,
  KeyPhysicalAttrs,
  Layer,
  MoveLayerResponse,
  PhysicalLayout,
  PhysicalLayouts,
  RemoveLayerResponse,
  RestoreLayerResponse,
  SaveChangesResponse,
  SetActivePhysicalLayoutResponse,
  SetLayerBindingResponse,
  SetLayerPropsResponse,
} from '@zmkfirmware/zmk-studio-ts-client/keymap';
