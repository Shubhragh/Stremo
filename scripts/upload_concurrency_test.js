import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    concurrent_uploads: {
      executor: "per-vu-iterations",
      vus: 20,
      iterations: 1,
      maxDuration: "3m",
    },
  },
};

const TOKEN = __ENV.TOKEN;
const FILE_PATH = __ENV.FILE_PATH || "./sample.mp4";
const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";

export default function () {
  const payload = {
    title: `Load Test Video ${__VU}-${Date.now()}`,
    description: "k6 concurrency upload test",
    file: http.file(open(FILE_PATH, "b"), "sample.mp4", "video/mp4"),
  };

  const response = http.post(`${BASE_URL}/videos/upload`, payload, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
    },
    timeout: "120s",
  });

  check(response, {
    "upload status is 201": (r) => r.status === 201,
  });
  sleep(1);
}
