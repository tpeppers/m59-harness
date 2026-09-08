// Read-only item valuation. No broker, login, quote request or sale is performed.
// Source: kod/include/blakston.khd MERCHANT_*; Monster.Offer (monster.kod);
// Item.GetValue (item.kod); NumberItem.GetValue (numbitem.kod).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MERCHANT_TIERS = Object.freeze({flat:0,bargain:1,discount:2,normal:3,expensive:4,ripoff:5});
export const normalizeItemName = name => String(name??'').trim().toLowerCase().replace(/[’‘]/g,"'").replace(/\s+/g,' ');
let defaultValues;
export function loadItemValues() {
  if(!defaultValues) defaultValues=Object.freeze(JSON.parse(readFileSync(new URL('../substrate/m59-values.json',import.meta.url),'utf8')).values);
  return defaultValues;
}
function nonnegative(value,label) {
  if(!Number.isSafeInteger(value)||value<0)throw Error(`${label} must be a nonnegative safe integer`);
  return value;
}
export function merchantMarkup(tier='normal') {
  const n=typeof tier==='string'?MERCHANT_TIERS[tier.toLowerCase()]:tier;
  if(!Number.isInteger(n)||n<0||n>5)throw Error('merchant must be flat, bargain, discount, normal, expensive, ripoff, or 0..5');
  return n;
}
function number(n) {const result=Number(n);if(!Number.isSafeInteger(result))throw Error('value exceeds safe integer range');return result;}

// A serializable reference-condition rule, suitable for non-JS clients. Apply
// the discount to the WHOLE STACK before truncating; not to each unit first.
export function itemSellValueRule(name,{merchant='normal',values=loadItemValues()}={}) {
  const key=normalizeItemName(name),markup=merchantMarkup(merchant);
  const base=Object.hasOwn(values,key)?values[key]:null;
  if(base===null)return {known:false,name:key,unit_value:null,merchant_markup:markup};
  nonnegative(base,'catalog value');
  return {known:true,name:key,unit_value:base,numerator:100-10*markup,denominator:100,minimum:1,
    merchant_markup:markup,basis:'reference-condition',estimated:true};
}
export function applySellValueRule(rule,quantity=1) {
  nonnegative(quantity,'quantity');
  if(!rule.known)return null;
  if(quantity===0)return 0;
  const raw=BigInt(nonnegative(rule.unit_value,'unit value'))*BigInt(quantity);
  const quote=raw*BigInt(rule.numerator)/BigInt(rule.denominator);
  return number(quote<BigInt(rule.minimum)?BigInt(rule.minimum):quote);
}

/** Estimate the sell price of one offered object/stack in shillings.
 * `quantity` is a stack size, not a list of separately offered objects.
 * `getValue` may supply the object's already-computed total GetValue result.
 * Otherwise assume reference condition; optional condition uses the exact
 * durability formula before any item-attribute AdjustPrice methods. Unknown
 * names stay unknown; never guess a base class from a magical item's name.
 * This does NOT assert a specific NPC accepts the item or uses Monster.Offer.
 */
export function estimateItemSellValue(name,{quantity=1,merchant='normal',values=loadItemValues(),getValue,condition}={}) {
  nonnegative(quantity,'quantity');
  const rule=itemSellValueRule(name,{merchant,values});
  let raw=null,basis=rule.basis??'unknown-item';
  if(getValue!==undefined){raw=BigInt(nonnegative(getValue,'getValue'));basis='supplied-get-value';}
  else if(rule.known){
    let unit=BigInt(rule.unit_value);
    if(condition!==undefined){
      const {hits,maxHits,originalMaxHits}=condition;
      nonnegative(hits,'hits');nonnegative(maxHits,'maxHits');nonnegative(originalMaxHits,'originalMaxHits');
      if(!originalMaxHits||hits>maxHits||maxHits>originalMaxHits||quantity!==1)throw Error('condition needs one non-stack item and 0 <= hits <= maxHits <= originalMaxHits');
      const percent=100n*BigInt(maxHits)*BigInt(hits)/(BigInt(originalMaxHits)**2n);
      unit=unit*percent/100n;
      unit=unit<10n?10n:unit;unit=unit>BigInt(rule.unit_value)?BigInt(rule.unit_value):unit;
      basis='supplied-condition-before-attributes';
    }
    raw=unit*BigInt(quantity);
  }
  const numerator=100-10*merchantMarkup(merchant);
  const sale=raw===null?null:quantity===0?0n:(raw*BigInt(numerator)/100n<1n?1n:raw*BigInt(numerator)/100n);
  return {name:String(name),quantity,merchant:Object.keys(MERCHANT_TIERS).find(k=>MERCHANT_TIERS[k]===rule.merchant_markup),
    merchant_markup:rule.merchant_markup,sell_percent:numerator,base_unit_value:rule.unit_value,
    item_value:raw===null?null:number(raw),sell_value:sale===null?null:number(sale),currency:'shillings',
    estimated:true,basis,acceptance:'not-checked',
    assumptions:basis==='reference-condition'?['reference condition','no unreported item attributes','merchant uses standard Monster.Offer']:['merchant uses standard Monster.Offer']};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2), option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
  if(!args[0]||args[0].startsWith('--')){console.error('usage: node tools/m59-item-value.mjs "red mushroom" [--quantity 12] [--merchant normal]');process.exitCode=2;}
  else {try{console.log(JSON.stringify(estimateItemSellValue(args[0],{quantity:Number(option('--quantity',1)),merchant:option('--merchant','normal')}),null,2));}
    catch(e){console.error(e.message);process.exitCode=2;}}
}
