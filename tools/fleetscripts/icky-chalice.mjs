// Make the committed acquisition recipe callable by name. The operator selects
// the caster explicitly; no public default names a private fleet character.
import {script as acquisition} from '../../substrate/fleetscripts.example/icky-chalice.mjs';
export const script={...acquisition,params:{...acquisition.params,
  caster:{type:'string',required:true,describe:'the selected Dispel Illusion caster, also included in agents'}}};
