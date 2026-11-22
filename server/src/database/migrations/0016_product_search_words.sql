-- 0016_product_search_words
--
-- Typo tolerance for product search, made fast. Instead of comparing a misspelt word with every
-- product's whole search document (trigram word-similarity over thousands of documents, measured
-- at ~0.5 s for 10,000 products), the API first corrects the word against this small vocabulary
-- of words that occur in the catalogue ("clasmate" -> "classmate"), then runs the normal indexed
-- search with the corrected word.
--
-- Words are only ever added (never removed): a word left behind by a rename simply finds no
-- products, which is harmless, and the table stays tiny (distinct words, numbers excluded).
-- Purchase prices are never part of a search document, so never part of this vocabulary.

CREATE TABLE product_search_words (
  word text PRIMARY KEY,
  CONSTRAINT product_search_words_valid CHECK (length(word) BETWEEN 4 AND 60 AND word !~ '^[0-9]+$')
);

CREATE INDEX product_search_words_trgm ON product_search_words USING gin (word gin_trgm_ops);

CREATE OR REPLACE FUNCTION refresh_product_search(ids uuid[]) RETURNS void
  LANGUAGE sql
  AS $$
  INSERT INTO product_search (product_id, document, supplier_document)
  SELECT p.id,
         product_search_norm(concat_ws(' ',
           b.name, p.name, c.name, p.size,
           CASE WHEN p.page_count IS NOT NULL THEN p.page_count::text || ' pages ' || p.page_count::text || 'p' END,
           CASE WHEN p.gsm IS NOT NULL THEN p.gsm::text || 'gsm ' || p.gsm::text || 'g' END,
           p.binding,
           array_to_string(p.search_aliases, ' '),
           (SELECT string_agg(a.value, ' ' ORDER BY a.key) FROM jsonb_each_text(p.attributes) a),
           p.sku,
           p.barcode)),
         product_search_norm((SELECT string_agg(s.name, ' ' ORDER BY s.name)
                                FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
                               WHERE ps.product_id = p.id))
    FROM products p
    LEFT JOIN brands b ON b.id = p.brand_id
    JOIN expense_categories c ON c.id = p.category_id
   WHERE p.id = ANY (ids)
  ON CONFLICT (product_id) DO UPDATE
     SET document = EXCLUDED.document, supplier_document = EXCLUDED.supplier_document;

  INSERT INTO product_search_words (word)
  SELECT DISTINCT w
    FROM product_search ps,
         unnest(string_to_array(ps.document || ' ' || ps.supplier_document, ' ')) AS w
   WHERE ps.product_id = ANY (ids)
     AND length(w) BETWEEN 4 AND 60
     AND w !~ '^[0-9]+$'
  ON CONFLICT (word) DO NOTHING;
  $$;

-- Words of products that already exist.
INSERT INTO product_search_words (word)
SELECT DISTINCT w
  FROM product_search ps,
       unnest(string_to_array(ps.document || ' ' || ps.supplier_document, ' ')) AS w
 WHERE length(w) BETWEEN 4 AND 60
   AND w !~ '^[0-9]+$'
ON CONFLICT (word) DO NOTHING;
