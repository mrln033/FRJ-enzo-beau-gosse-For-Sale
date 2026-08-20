-- d.7.3 : recalcule les estimations historiques avec la précision d.7.1.
-- Les quantités historiques sont conservées : les modifier silencieusement
-- changerait le contenu accepté de demandes déjà transmises.

UPDATE purchase_order_items
SET unit_sale_ped = ROUND(
      CASE
        WHEN markup_kind = 'percent' AND markup_value IS NOT NULL THEN unit_tt_ped * markup_value
        WHEN markup_kind = 'ped' AND markup_value IS NOT NULL THEN unit_tt_ped + markup_value
        ELSE unit_tt_ped
      END,
      6
    ),
    line_tt_ped = ROUND(unit_tt_ped * quantity, 2),
    line_sale_ped = ROUND(
      (CASE
        WHEN markup_kind = 'percent' AND markup_value IS NOT NULL THEN unit_tt_ped * markup_value
        WHEN markup_kind = 'ped' AND markup_value IS NOT NULL THEN unit_tt_ped + markup_value
        ELSE unit_tt_ped
      END) * quantity,
      2
    )
WHERE ABS(unit_sale_ped - ROUND(
        CASE
          WHEN markup_kind = 'percent' AND markup_value IS NOT NULL THEN unit_tt_ped * markup_value
          WHEN markup_kind = 'ped' AND markup_value IS NOT NULL THEN unit_tt_ped + markup_value
          ELSE unit_tt_ped
        END,
        6
      )) > 0.0000005
   OR ABS(line_tt_ped - ROUND(unit_tt_ped * quantity, 2)) > 0.0005
   OR ABS(line_sale_ped - ROUND(
        (CASE
          WHEN markup_kind = 'percent' AND markup_value IS NOT NULL THEN unit_tt_ped * markup_value
          WHEN markup_kind = 'ped' AND markup_value IS NOT NULL THEN unit_tt_ped + markup_value
          ELSE unit_tt_ped
        END) * quantity,
        2
      )) > 0.0005;

UPDATE purchase_orders
SET total_tt_ped = ROUND(COALESCE((
      SELECT SUM(item.line_tt_ped)
      FROM purchase_order_items item
      WHERE item.order_id = purchase_orders.id
    ), 0), 2),
    total_sale_ped = ROUND(COALESCE((
      SELECT SUM(item.line_sale_ped)
      FROM purchase_order_items item
      WHERE item.order_id = purchase_orders.id
    ), 0), 2)
WHERE ABS(total_tt_ped - ROUND(COALESCE((
        SELECT SUM(item.line_tt_ped)
        FROM purchase_order_items item
        WHERE item.order_id = purchase_orders.id
      ), 0), 2)) > 0.0005
   OR ABS(total_sale_ped - ROUND(COALESCE((
        SELECT SUM(item.line_sale_ped)
        FROM purchase_order_items item
        WHERE item.order_id = purchase_orders.id
      ), 0), 2)) > 0.0005;
