"""验证官方 API 文档的公开边界和多版本线元数据。"""

import sys
import unittest

sys.dont_write_bytecode = True

from generate_jlceda_api_doc import build_api_metadata, filter_non_public_symbols


def symbol(symbol_id, *, parent_id=None, kind="method", modifiers=(), tags=()):
    return {
        "id": symbol_id,
        "parentId": parent_id,
        "kind": kind,
        "modifiers": list(modifiers),
        "jsDoc": {"blocks": [{"tags": list(tags)}]},
    }


class ApiDocumentTests(unittest.TestCase):
    def test_private_internal_and_constructor_descendants_are_excluded(self):
        public = symbol(1, kind="class")
        public_method = symbol(2, parent_id=1)
        private = symbol(3, parent_id=1, modifiers=["PrivateKeyword"])
        nested_private_type = symbol(4, parent_id=3, kind="property")
        internal = symbol(5, kind="class", tags=[{"tagName": "internal"}])
        internal_method = symbol(6, parent_id=5)
        constructor = symbol(7, parent_id=1, kind="constructor")
        constructor_parameter = symbol(8, parent_id=7, kind="property")
        protected = symbol(9, parent_id=1, modifiers=["ProtectedKeyword"])
        # 子项先于父项出现也必须过滤。
        result = filter_non_public_symbols([
            nested_private_type, internal_method, constructor_parameter,
            public, public_method, private, internal, constructor, protected,
        ])
        self.assertEqual([item["id"] for item in result], [1, 2])

    def test_parallel_release_branches_and_remarks_are_preserved(self):
        metadata = build_api_metadata(symbol(1, tags=[
            {"tagName": "beta"},
            {"tagName": "remarks", "text": "仅客户端有效。\nADD since EDA v3.2.183 / EDA v4.1.23"},
            {"tagName": "deprecated", "text": "since EDA v4.2"},
        ]))
        self.assertEqual(metadata["minimumEditorVersions"], ["3.2.183", "4.1.23"])
        self.assertEqual(metadata["stability"], "beta")
        self.assertIn("仅客户端有效", metadata["remarks"])
        self.assertTrue(metadata["deprecated"])
        self.assertEqual(metadata["deprecationMessage"], "since EDA v4.2")

    def test_deprecation_or_modified_version_is_not_a_minimum(self):
        metadata = build_api_metadata(symbol(1, tags=[
            {"tagName": "deprecated", "text": "since EDA v4.2"},
            {"tagName": "remarks", "text": "MODIFY since EDA v4.1.62"},
        ]))
        self.assertNotIn("minimumEditorVersions", metadata)

    def test_since_tag_and_major_only_versions(self):
        metadata = build_api_metadata(symbol(1, tags=[
            {"tagName": "since", "text": "EDA v5"},
            {"tagName": "since", "text": "v5"},
        ]))
        self.assertEqual(metadata["minimumEditorVersions"], ["5"])


if __name__ == "__main__":
    unittest.main()
