import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function uuid(value) {
  if (typeof value !== "string" ||
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value))
    throw new Error("Expected a UUID");
  return value.toLowerCase();
}

function fields(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== names.length || !names.every(key => Object.hasOwn(value, key)))
    throw new Error("Expected fields: " + names.join(", "));
}

export function cardSQL(command, batch) {
  fields(batch, ["owner_id", "items"]);
  const owner = uuid(batch.owner_id);
  if (!Array.isArray(batch.items) || batch.items.length === 0) throw new Error("Empty batch");
  const rows = [];
  const ids = new Set();
  function add(card, kind, cue = null) {
    fields(card, ["id", "front", "back"]);
    const id = uuid(card.id);
    if (ids.has(id)) throw new Error("Repeated card ID");
    for (const side of [card.front, card.back]) {
      if (typeof side !== "string" || !side.trim() || side.includes("\0"))
        throw new Error("Expected nonempty front and back");
    }
    ids.add(id);
    rows.push({ id, front: card.front, back: card.back, kind, cue_card_id: cue });
    return id;
  }
  for (const item of batch.items) {
    if (item?.kind === "fact") {
      fields(item, ["kind", "card"]);
      add(item.card, "fact");
    } else if (item?.kind === "habit") {
      fields(item, ["kind", "cue", "action"]);
      const cue = add(item.cue, "habit-recall");
      add(item.action, "habit-action", cue);
    } else throw new Error("Expected a fact or paired habit");
  }

  // The SQL connector accepts statement text. Keep card text entirely in a data literal.
  const hex = Buffer.from(JSON.stringify(rows), "utf8").toString("hex");
  const input = `jsonb_to_recordset(convert_from(decode('${hex}','hex'),'UTF8')::jsonb)
    as r(id uuid, front text, back text, kind text, cue_card_id uuid)`;
  if (command === "verify") return `select c.id, c.owner_id, c.front, c.back, c.kind, c.cue_card_id,
    c.active, c.due_at from flashcards_private.cards c join ${input} on c.id = r.id
    where c.owner_id = '${owner}'::uuid order by c.id;`;
  if (command !== "insert") throw new Error("Expected insert or verify");
  return `do $add_cards$
begin
  insert into flashcards_private.cards (id, owner_id, front, back, kind, cue_card_id)
    select id, '${owner}'::uuid, front, back, kind, cue_card_id from ${input}
    order by id on conflict (id) do nothing;
  if exists (
    select 1 from ${input}
    left join flashcards_private.cards c on c.id = r.id and c.owner_id = '${owner}'::uuid
    where c.id is null or (c.front, c.back, c.kind, c.cue_card_id)
      is distinct from (r.front, r.back, r.kind, r.cue_card_id)
  ) then
    raise exception 'Card ID conflicts with the approved batch';
  end if;
end
$add_cards$;`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(cardSQL(process.argv[2], JSON.parse(readFileSync(0, "utf8"))));
