//! WITH LINKS and FOLLOW LINKS integration tests.

mod common;

use engram_aql::Executor;

#[test]
fn with_links_attaches_link_metadata() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    // e-001 is a deploy chunk linked via chunk_entities to ent-deploy,
    // which has a relation 'uses_pattern' to ent-bluegreen
    let result = exec
        .query(r#"RECALL FROM EPISODIC KEY id = "e-001" WITH LINKS ALL"#)
        .unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert_eq!(result.count, 1);
    // Should have link metadata attached from the relations table
    assert!(
        result.links.is_some(),
        "expected links metadata to be attached"
    );
    let links = result.links.as_ref().unwrap();
    assert!(!links.is_empty(), "expected at least one link");
}

#[test]
fn with_links_type_filter_limits_to_matching_type() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"RECALL FROM EPISODIC KEY id = "e-001" WITH LINKS TYPE "uses_pattern""#)
        .unwrap();
    assert!(result.success, "error: {:?}", result.error);
    if let Some(links) = &result.links {
        // All returned links should be of type uses_pattern
        for link in links {
            assert_eq!(link.link_type, "uses_pattern");
        }
    }
}

#[test]
fn follow_links_does_not_crash() {
    // Smoke test: FOLLOW LINKS with DEPTH 1 should return at least the base result.
    // The seed has sparse graph data, so we don't assert on expanded row counts — just
    // confirm the recursive CTE executes cleanly and doesn't corrupt the base result.
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(
            r#"RECALL FROM EPISODIC KEY id = "e-001" FOLLOW LINKS TYPE "uses_pattern" DEPTH 1"#,
        )
        .unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert!(result.count >= 1);
}

#[test]
fn no_graph_modifiers_returns_no_links_field() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("RECALL FROM EPISODIC ALL LIMIT 1").unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert!(
        result.links.is_none(),
        "plain RECALL should not populate links"
    );
}
