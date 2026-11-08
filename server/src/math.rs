// SHARED STRUCTS
use spacetimedb::SpacetimeType;

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Default)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}