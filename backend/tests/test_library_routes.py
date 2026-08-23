"""Finding your work, over HTTP -- and never anyone else's.

The load-bearing test here is the last one: a facet must only ever
narrow a set the caller may already see. If a filter could widen it,
the browse controls would become an authorization bypass.
"""

from app.db.models import UserItemState
from tests.test_report_routes import sign_in, valid_definition


def make_report(client, name):
    definition = valid_definition()
    definition["name"] = name
    return client.post("/api/reports", json={"definition": definition}).json()["id"]


def names(response) -> list[str]:
    return [r["name"] for r in response.json()["reports"]]


class TestSearch:
    def test_search_matches_the_name(self, client, db):
        sign_in(client, db)
        db.commit()
        make_report(client, "Quarterly pipeline")
        make_report(client, "Churn by segment")
        assert names(client.get("/api/reports", params={"q": "churn"})) == [
            "Churn by segment"
        ]

    def test_search_ignores_case_and_surrounding_space(self, client, db):
        sign_in(client, db)
        db.commit()
        make_report(client, "Quarterly pipeline")
        assert len(names(client.get("/api/reports", params={"q": "  QUARTERLY "}))) == 1

    def test_search_matches_the_semantic_view(self, client, db):
        sign_in(client, db)
        db.commit()
        make_report(client, "Anything at all")
        # valid_definition() binds the SALES view.
        assert len(names(client.get("/api/reports", params={"q": "sales"}))) == 1

    def test_no_match_is_an_empty_list_not_an_error(self, client, db):
        sign_in(client, db)
        db.commit()
        make_report(client, "Quarterly pipeline")
        response = client.get("/api/reports", params={"q": "nothing-like-this"})
        assert response.status_code == 200
        assert names(response) == []


class TestFavorites:
    def test_pinning_shows_on_the_summary_and_filters(self, client, db):
        sign_in(client, db)
        db.commit()
        keep = make_report(client, "Keep me")
        make_report(client, "Ignore me")

        pinned = client.post(
            f"/api/library/report/{keep}/favorite", json={"favorite": True}
        )
        assert pinned.status_code == 200

        listed = client.get("/api/reports").json()["reports"]
        assert {r["name"]: r["favorite"] for r in listed} == {
            "Keep me": True,
            "Ignore me": False,
        }
        assert names(client.get("/api/reports", params={"favorite": True})) == ["Keep me"]

    def test_unpinning_puts_it_back(self, client, db):
        sign_in(client, db)
        db.commit()
        report_id = make_report(client, "Fickle")
        client.post(f"/api/library/report/{report_id}/favorite", json={"favorite": True})
        client.post(f"/api/library/report/{report_id}/favorite", json={"favorite": False})
        assert names(client.get("/api/reports", params={"favorite": True})) == []

    def test_a_non_member_cannot_pin_or_even_learn_it_exists(self, client, db):
        sign_in(client, db, user="ALICE")
        db.commit()
        report_id = make_report(client, "Alice's")
        client.cookies.clear()
        sign_in(client, db, user="BOB")
        db.commit()
        refused = client.post(
            f"/api/library/report/{report_id}/favorite", json={"favorite": True}
        )
        assert refused.status_code == 404

    def test_an_unknown_item_kind_is_a_404(self, client, db):
        sign_in(client, db)
        db.commit()
        report_id = make_report(client, "Real")
        assert client.post(
            f"/api/library/dashboard/{report_id}/favorite", json={"favorite": True}
        ).status_code == 404


class TestRecents:
    def test_viewing_records_and_sorts_first(self, client, db):
        sign_in(client, db)
        db.commit()
        first = make_report(client, "First")
        make_report(client, "Second")
        assert client.post(f"/api/library/report/{first}/view").status_code == 200

        listed = client.get("/api/reports", params={"sort": "recent"}).json()["reports"]
        assert listed[0]["name"] == "First"
        assert listed[0]["lastViewedAt"] is not None
        # Everything still listed: recency orders, it does not filter.
        assert len(listed) == 2

    def test_recents_are_per_user(self, client, db):
        sign_in(client, db, user="ALICE")
        db.commit()
        report_id = make_report(client, "Shared")
        client.post(f"/api/library/report/{report_id}/view")
        client.cookies.clear()
        sign_in(client, db, user="BOB")
        db.commit()
        # Bob is not a member, so he sees nothing -- and certainly not
        # Alice's history.
        assert names(client.get("/api/reports")) == []


class TestSort:
    def test_name_sort(self, client, db):
        sign_in(client, db)
        db.commit()
        make_report(client, "Zebra")
        make_report(client, "apple")
        assert names(client.get("/api/reports", params={"sort": "name"})) == [
            "apple",
            "Zebra",
        ]


class TestDeletionCleansUp:
    def test_state_does_not_outlive_the_item(self, client, db):
        sign_in(client, db)
        db.commit()
        report_id = make_report(client, "Doomed")
        client.post(f"/api/library/report/{report_id}/favorite", json={"favorite": True})
        client.delete(f"/api/reports/{report_id}")
        assert db.query(UserItemState).count() == 0


class TestFacetsOnlyNarrow:
    def test_no_filter_can_reveal_another_users_work(self, client, db):
        sign_in(client, db, user="ALICE")
        db.commit()
        make_report(client, "Alice private")
        client.cookies.clear()
        sign_in(client, db, user="BOB")
        db.commit()
        for params in (
            {},
            {"q": "alice"},
            {"favorite": True},
            {"role": "ANALYST"},
            {"sort": "name"},
            {"q": "", "role": ""},
        ):
            assert names(client.get("/api/reports", params=params)) == []
