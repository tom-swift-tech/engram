//! Tests for the LE-f32 BLOB codec and the `vec_distance_cosine` scalar fn.
//!
//! TDD order: this file is written before `src/vector/` exists so
//! `cargo test --test vector_cosine` fails to compile first.

mod common;

use engram_aql::vector::codec::{decode_f32_le, encode_f32_le};
use engram_aql::vector::cosine::register_vec_distance_cosine;
use rusqlite::Connection;

// ---------------------------------------------------------------------------
// Codec round-trip
// ---------------------------------------------------------------------------

#[test]
fn codec_round_trips_small_vec() {
    let original = vec![1.0_f32, -2.5, 0.0, 1.5];
    let blob = encode_f32_le(&original);
    let decoded = decode_f32_le(&blob).expect("decode should succeed");
    assert_eq!(original, decoded);
}

#[test]
fn codec_768_vec_produces_3072_byte_blob() {
    let v: Vec<f32> = (0..768).map(|i| i as f32 * 0.001).collect();
    let blob = encode_f32_le(&v);
    assert_eq!(
        blob.len(),
        768 * 4,
        "768-dim vector must encode to 3072 bytes"
    );
    let decoded = decode_f32_le(&blob).expect("decode should succeed");
    for (a, b) in v.iter().zip(decoded.iter()) {
        assert!(
            (a - b).abs() < 1e-7,
            "round-trip value mismatch: {a} vs {b}"
        );
    }
}

#[test]
fn decode_returns_none_for_non_multiple_of_4() {
    // 5 bytes is not a multiple of 4
    let bad = vec![0u8; 5];
    assert!(decode_f32_le(&bad).is_none());
}

#[test]
fn decode_empty_blob_returns_empty_vec() {
    let decoded = decode_f32_le(&[]).expect("empty blob is valid (zero-dim)");
    assert!(decoded.is_empty());
}

// ---------------------------------------------------------------------------
// Helper: open an in-memory DB with schema + cosine fn registered
// ---------------------------------------------------------------------------

fn cosine_db() -> Connection {
    let conn = common::fresh_db();
    register_vec_distance_cosine(&conn).expect("register should succeed on in-memory connection");
    conn
}

// Encode a Vec<f32> blob and return it as a Vec<u8> ready for rusqlite binding.
fn blob(v: &[f32]) -> Vec<u8> {
    encode_f32_le(v)
}

fn call_cosine(conn: &Connection, a: &[f32], b: &[f32]) -> f64 {
    let ba = blob(a);
    let bb = blob(b);
    conn.query_row(
        "SELECT vec_distance_cosine(?, ?)",
        rusqlite::params![ba, bb],
        |row| row.get::<_, f64>(0),
    )
    .expect("vec_distance_cosine should return a value")
}

// ---------------------------------------------------------------------------
// Cosine distance correctness — normalized vectors
// ---------------------------------------------------------------------------

#[test]
fn cosine_identical_normalized_returns_zero() {
    let conn = cosine_db();
    let v = vec![
        1.0_f32 / 3.0_f32.sqrt(),
        1.0 / 3.0_f32.sqrt(),
        1.0 / 3.0_f32.sqrt(),
    ];
    let dist = call_cosine(&conn, &v, &v);
    assert!(
        dist.abs() < 1e-6,
        "identical normalized vectors should have distance 0.0, got {dist}"
    );
}

#[test]
fn cosine_orthogonal_normalized_returns_one() {
    let conn = cosine_db();
    let a = vec![1.0_f32, 0.0, 0.0];
    let b = vec![0.0_f32, 1.0, 0.0];
    let dist = call_cosine(&conn, &a, &b);
    assert!(
        (dist - 1.0).abs() < 1e-6,
        "orthogonal normalized vectors should have distance 1.0, got {dist}"
    );
}

#[test]
fn cosine_antiparallel_normalized_returns_two() {
    let conn = cosine_db();
    let a = vec![1.0_f32, 0.0, 0.0];
    let b = vec![-1.0_f32, 0.0, 0.0];
    let dist = call_cosine(&conn, &a, &b);
    assert!(
        (dist - 2.0).abs() < 1e-6,
        "antiparallel normalized vectors should have distance 2.0, got {dist}"
    );
}

// ---------------------------------------------------------------------------
// Cosine distance correctness — NON-normalized vectors (proves full formula)
// ---------------------------------------------------------------------------

#[test]
fn cosine_identical_unnormalized_returns_zero() {
    let conn = cosine_db();
    // Scale by arbitrary factor — cosine distance must still be 0
    let v = vec![3.5_f32, -7.0, 12.0];
    let dist = call_cosine(&conn, &v, &v);
    assert!(
        dist.abs() < 1e-6,
        "identical unnormalized vectors should have distance 0.0, got {dist}"
    );
}

#[test]
fn cosine_orthogonal_unnormalized_returns_one() {
    let conn = cosine_db();
    let a = vec![4.0_f32, 0.0, 0.0];
    let b = vec![0.0_f32, 9.0, 0.0];
    let dist = call_cosine(&conn, &a, &b);
    assert!(
        (dist - 1.0).abs() < 1e-6,
        "orthogonal unnormalized vectors should have distance 1.0, got {dist}"
    );
}

#[test]
fn cosine_antiparallel_unnormalized_returns_two() {
    let conn = cosine_db();
    // Different magnitudes, opposite direction — cosine distance must be 2
    let a = vec![5.0_f32, 0.0, 0.0];
    let b = vec![-2.5_f32, 0.0, 0.0];
    let dist = call_cosine(&conn, &a, &b);
    assert!(
        (dist - 2.0).abs() < 1e-6,
        "antiparallel unnormalized vectors should have distance 2.0, got {dist}"
    );
}

#[test]
fn cosine_known_angle() {
    let conn = cosine_db();
    // a = [1, 1], b = [1, 0] → cos θ = 1/√2, distance = 1 - 1/√2 ≈ 0.29289
    let a = vec![1.0_f32, 1.0];
    let b = vec![1.0_f32, 0.0];
    let dist = call_cosine(&conn, &a, &b);
    let expected = 1.0 - (1.0_f64 / 2.0_f64.sqrt());
    assert!(
        (dist - expected).abs() < 1e-6,
        "expected {expected}, got {dist}"
    );
}

// ---------------------------------------------------------------------------
// 768-dimensional smoke test (matches typical embedding dimension)
// ---------------------------------------------------------------------------

#[test]
fn cosine_768_dim_identical() {
    let conn = cosine_db();
    let v: Vec<f32> = (0..768).map(|i| (i as f32).sin()).collect();
    let dist = call_cosine(&conn, &v, &v);
    assert!(
        dist.abs() < 1e-5,
        "768-dim identical vectors: expected ~0.0, got {dist}"
    );
}

// ---------------------------------------------------------------------------
// Dimension mismatch returns a SQLite error (not a panic)
// ---------------------------------------------------------------------------

#[test]
fn cosine_dim_mismatch_returns_error_not_panic() {
    let conn = cosine_db();
    let a: Vec<u8> = encode_f32_le(&vec![1.0_f32; 768]);
    let b: Vec<u8> = encode_f32_le(&vec![1.0_f32; 384]);
    let result = conn.query_row(
        "SELECT vec_distance_cosine(?, ?)",
        rusqlite::params![a, b],
        |row| row.get::<_, f64>(0),
    );
    assert!(
        result.is_err(),
        "dim mismatch should return a SQLite error, not a value"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("768") || err_msg.contains("384") || err_msg.contains("mismatch"),
        "error message should mention dimensions or mismatch, got: {err_msg}"
    );
}
