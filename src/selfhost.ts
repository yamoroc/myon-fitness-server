// Self-hosted data server for 米亚健身 / Myon Fitness (the app's 数据存储 › 自己的服务器). No AI-coach relay: the app
// always talks to Myon's own relay for that.
import { configOrExit, listen, openServer, startSnapshots } from "./server";

const cfg = configOrExit();
const { db, app } = openServer(cfg);
startSnapshots(cfg.dataDir, [["fitness", db]]);
listen(app, cfg, "myon-fitness-server");
