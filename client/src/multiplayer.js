// CoScene multiplayer layer: the only place the client talks to SpacetimeDB.
// Not wired up yet. Search the editor for "#SPACETIME" to find every spot that will call into this file.
//
// ---------------------------------------------------------------------------
// Contract with the server module (server/), agreed in the project spec.
// If the server team changes a name or argument, update this list and the markers.
//
// Tables (public)
//   scene_object: id (string uuid, PK), kind ('box'|'sphere'|'cylinder'|'plane'|'pointlight'),
//                 px py pz, rx ry rz, sx sy sz (f32), color (hex string),
//                 lockedBy (optional Identity), createdBy (Identity)
//   user:         identity (PK), name, color (hex), online (bool)
//
// Reducers
//   add_object( id, kind, px, py, pz, color )  -> Menubar.Add.js
//   update_transform( id, px..sz )             -> Viewport.js (gizmo), Sidebar.Object.js
//   update_color( id, color )                  -> Sidebar.Material.ColorProperty.js
//   delete_object( id )                        -> Menubar.Edit.js, Sidebar.Settings.Shortcuts.js
//   lock_object( id ) / unlock_object( id )    -> Selector.js (setSelection)
//   set_name( name )                           -> online-users panel (name prompt)
//   connect / disconnect lifecycle             -> server only, nothing to call
// ---------------------------------------------------------------------------
//
// #SPACETIME (Phase 3) connection
//   - generated bindings go in ./module_bindings (`spacetime generate`, check flags with --help)
//   - URI + database name come from import.meta.env (VITE_SPACETIME_URI, VITE_SPACETIME_DB),
//     defaulting to ws://localhost:3000 and "coscene"
//   - save the auth token in localStorage so a refresh keeps the same identity
//   - subscribe to scene_object and user
//   - small connection-status badge in the editor UI
//
// #SPACETIME (Phase 4) database-driven rendering: the DB is the truth
//   - Map<rowId, THREE.Object3D>
//   - applyRow( row ): create the mesh/light from row.kind if missing (MeshStandardMaterial,
//     userData.id = row.id, add to editor.scene); set transform unless userData.dragging;
//     set color; update lock visuals; dispatch editor signals (sceneGraphChanged, objectChanged)
//   - removeRow( row ): remove from editor.scene, dispose geometry/material, deselect if selected
//   - onInsert / onUpdate -> applyRow, onDelete -> removeRow
//   - NEVER add/remove synced objects in editor.scene anywhere else
//
// #SPACETIME (Phase 4) lock visuals + presence
//   - object locked by someone else: BoxHelper/outline in that user's color + CSS2D name label
//   - online-users panel (colored dots + names); name prompt on first visit -> set_name

export {};
