#!/usr/bin/env bash
# Armed-peer race regression (F9/F10): the phone saves a price edit while another device sells 1 unit of
# the same product, with the remote sale fired 0–1.6 s before "Guardar". Expected on phone AND cloud:
# the new price and stock base−1. Uses the LOCAL Firebase emulators only (tools/emulators.sh) and the
# throwaway account the phone is currently signed into (e.g. the one tools/regress-sync.mjs created).
# Usage: bash tools/race.sh <email> <password>
set -uo pipefail
cd "$(dirname "$0")/.."
E="$1"; P="$2"
cdp() { node tools/cdp.mjs "$1"; }
fails=0
run() {
  local name="$1" offset="$2"
  local id stock0 price0 newp
  read -r id stock0 price0 < <(cdp "(()=>{const p=state.products.find(x=>x.name==='$name');return p.id+' '+p.stock+' '+p.salePrice})()" | tr -d '"')
  newp=$((price0 + 100))
  rm -f tools/out/fire tools/out/armed.log
  (node tools/sync-peer.mjs armed-sale "$E" "$P" "$name" 2>/dev/null > tools/out/armed.log &)
  for i in $(seq 1 90); do grep -q ARMED tools/out/armed.log 2>/dev/null && break; sleep 2; done
  cdp "closeModal();openEditProduct($id);(()=>{const e=document.getElementById('inputProdSale');e.value='$newp';e.dispatchEvent(new Event('input'));return 1})()" >/dev/null
  touch tools/out/fire
  sleep "$offset"
  cdp "[...document.querySelectorAll('#modalContainer .modal-footer button')].find(b=>/Guardar/.test(b.innerText)).click();1" >/dev/null
  local want="$((stock0 - 1))/$newp" ph cl ok=0
  for i in $(seq 1 24); do
    sleep 10
    ph=$(cdp "(()=>{const p=state.products.find(x=>x.id===$id);return p.stock+'/'+p.salePrice+'/'+state.cloudStatus})()" | tr -d '"')
    cl=$(node tools/sync-peer.mjs stock "$E" "$P" "$name" 2>/dev/null | grep cloud)
    if [[ "$ph" == "$want/synced" && "$cl" == *"= $((stock0 - 1)) price=$newp"* ]]; then ok=1; break; fi
  done
  if [[ $ok == 1 ]]; then echo "PASS  race '$name' offset ${offset}s — phone $ph | $cl"; else echo "FAIL  race '$name' offset ${offset}s — want $want | phone $ph | $cl"; fails=$((fails+1)); fi
}
run "Aluminio 12" 0
run "Aluminio 20m" 0.3
run "Aluminio 5m" 0.7
run "Calendario chico" 1.2
run "Calendario grande" 1.6
echo "$((5 - fails))/5 races converged"
exit $fails
