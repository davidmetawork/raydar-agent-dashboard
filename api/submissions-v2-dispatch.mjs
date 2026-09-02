import { routeSubmissionsV2 } from "./submissions-v2/_lib/router.mjs";

export const config = { api: { bodyParser: false }, maxDuration: 300 };

export default routeSubmissionsV2;
