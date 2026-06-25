//! Vector utilities for engram-aql.
//!
//! - `codec` — LE-f32 BLOB ↔ `Vec<f32>` (dimension-agnostic, matches TS storage format)
//! - `cosine` — native `vec_distance_cosine` scalar fn registered on a SQLite connection

pub mod codec;
pub mod cosine;
