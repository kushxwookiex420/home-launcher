// The schema served at /openapi.json. Imported by index.js and used by the ChatGPT action.
// ChatGPT needs unique operationIds, a summary per operation and absolute server URLs.

const errRef = { $ref: "#/components/schemas/Error" };
const errResponse = (description) => ({
  description,
  content: { "application/json": { schema: errRef } }
});

const RAW = {
  openapi: "3.1.0",
  info: {
    title: "Home Bridge",
    description:
      "Bridge between an outside assistant (a ChatGPT custom action) and a paired Android launcher plus its coding agent. Call POST /note to hand work to the agent, GET /replies to read results, and the shared-folder operations to inspect project files. Phone actions are limited to the relay whitelist and are still re-validated on the device.",
    version: "1.2.0"
  },
  servers: [{ url: "https://home-bridge-qn2hnd-preview.freebuff.site" }],
  security: [{ pairingCode: [] }],
  components: {
    securitySchemes: {
      pairingCode: {
        type: "apiKey",
        in: "query",
        name: "code",
        description:
          "The 6-character code shown on the phone. Also accepted as an Authorization: Bearer token."
      }
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          ok: { type: "boolean", const: false },
          error: { type: "string" },
          code: { type: "string" }
        },
        required: ["ok", "error"]
      },
      Task: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          source: { type: "string" },
          status: { type: "string", enum: ["queued", "working", "done"] },
          createdAt: { type: "number", description: "Epoch milliseconds." },
          iso: { type: "string", description: "ISO-8601 time." },
          replyId: { type: "string" },
          artifacts: { type: "array", items: { type: "string" } }
        }
      },
      Reply: {
        type: "object",
        properties: {
          id: { type: "string" },
          taskId: { type: "string" },
          source: { type: "string" },
          text: { type: "string" },
          artifacts: { type: "array", items: { type: "string" } },
          createdAt: { type: "number" },
          iso: { type: "string" }
        }
      },
      FileEntry: {
        type: "object",
        properties: {
          name: { type: "string" },
          mime: { type: "string" },
          encoding: { type: "string", enum: ["text", "base64"] },
          size: { type: "integer" },
          updatedAt: { type: "number" },
          iso: { type: "string" }
        }
      }
    }
  },
  paths: {
    "/note": {
      post: {
        operationId: "handTaskToAgent",
        summary: "Hand a task to the coding agent",
        description:
          "Queues one task for the agent (Buff). One clear task per call. Returns the task id; read the answer with readAgentReplies or check progress with taskStatus.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  code: { type: "string", description: "Pairing code shown on the phone." },
                  text: { type: "string", maxLength: 4000, description: "The task, in plain language." },
                  title: { type: "string", maxLength: 120, description: "Short label, optional." },
                  source: { type: "string", description: "Who wrote it, e.g. chatgpt." }
                },
                required: ["code", "text"]
              }
            }
          }
        },
        responses: {
          200: {
            description: "Stored",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    taskId: { type: "string" },
                    createdAt: { type: "number" }
                  }
                }
              }
            }
          },
          400: errResponse("Empty or invalid task"),
          401: errResponse("Missing or unknown pairing code"),
          429: errResponse("Rate limited")
        }
      }
    },
    "/notes": {
      get: {
        operationId: "pendingTasks",
        summary: "Tasks still waiting for the agent",
        description: "Unacknowledged tasks, oldest first. Use taskStatus for a full list with statuses.",
        parameters: [
          { name: "code", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 50 } }
        ],
        responses: {
          200: {
            description: "Queued tasks",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    count: { type: "integer" },
                    tasks: { type: "array", items: { $ref: "#/components/schemas/Task" } }
                  }
                }
              }
            }
          },
          401: errResponse("Unauthorized")
        }
      }
    },
    "/tasks": {
      get: {
        operationId: "taskStatus",
        summary: "Every task with its status and result",
        description:
          "Newest first. status is queued (not picked up), working (claimed by the agent) or done (a reply was written). Each task carries its reply id and artifact links when finished.",
        parameters: [
          { name: "code", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 50 } }
        ],
        responses: {
          200: {
            description: "Tasks with status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    count: { type: "integer" },
                    tasks: { type: "array", items: { $ref: "#/components/schemas/Task" } }
                  }
                }
              }
            }
          },
          401: errResponse("Unauthorized")
        }
      }
    },
    "/reply": {
      post: {
        operationId: "replyToChat",
        summary: "Agent writes a result back",
        description: "Used by the coding agent. Link it to a task with taskId so the task is marked done.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  code: { type: "string" },
                  text: { type: "string", maxLength: 4000 },
                  taskId: { type: "string", description: "The task this answers." },
                  artifacts: {
                    type: "array",
                    maxItems: 10,
                    items: { type: "string" },
                    description: "Links to APKs, patches or reports."
                  }
                },
                required: ["code", "text"]
              }
            }
          }
        },
        responses: {
          200: {
            description: "Stored",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    replyId: { type: "string" },
                    taskId: { type: "string" }
                  }
                }
              }
            }
          },
          400: errResponse("Empty reply, unknown taskId or bad artifact link"),
          401: errResponse("Unauthorized")
        }
      }
    },
    "/replies": {
      get: {
        operationId: "readAgentReplies",
        summary: "Results the agent wrote",
        description:
          "Oldest first, so the newest is last. Call after handing a task off, or when the user asks whether work is finished. Each reply carries its taskId, timestamps and artifact links.",
        parameters: [
          { name: "code", in: "query", required: false, schema: { type: "string" } },
          {
            name: "since",
            in: "query",
            required: false,
            schema: { type: "number", description: "Epoch ms; only newer replies." }
          },
          { name: "taskId", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 50 } }
        ],
        responses: {
          200: {
            description: "Replies",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    count: { type: "integer" },
                    serverTime: { type: "number" },
                    replies: { type: "array", items: { $ref: "#/components/schemas/Reply" } }
                  }
                }
              }
            }
          },
          401: errResponse("Unauthorized")
        }
      }
    },
    "/files": {
      get: {
        operationId: "listSharedFiles",
        summary: "List the shared folder",
        parameters: [{ name: "code", in: "query", required: false, schema: { type: "string" } }],
        responses: {
          200: {
            description: "Names, sizes, encodings and dates",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    count: { type: "integer" },
                    files: { type: "array", items: { $ref: "#/components/schemas/FileEntry" } }
                  }
                }
              }
            }
          },
          401: errResponse("Unauthorized")
        }
      },
      post: {
        operationId: "uploadSharedFile",
        summary: "Put a file in the shared folder",
        description:
          "Text or base64, at most 200000 characters. Paths are relative, forward slashes only; '..', leading slashes, hidden files and key files are refused. Replaces a file with the same name.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  code: { type: "string" },
                  name: { type: "string", maxLength: 200, description: "Relative path, e.g. docs/API.md" },
                  content: { type: "string", maxLength: 200000 },
                  encoding: { type: "string", enum: ["text", "base64"] },
                  mime: { type: "string" }
                },
                required: ["code", "name", "content"]
              }
            }
          }
        },
        responses: {
          200: {
            description: "Stored",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    name: { type: "string" },
                    bytes: { type: "integer" },
                    sha256: { type: "string" }
                  }
                }
              }
            }
          },
          400: errResponse("Invalid path or missing content"),
          401: errResponse("Unauthorized"),
          413: errResponse("File larger than 200000 characters")
        }
      }
    },
    "/file": {
      get: {
        operationId: "readSharedFile",
        summary: "Read one file from the shared folder",
        parameters: [
          { name: "code", in: "query", required: false, schema: { type: "string" } },
          { name: "name", in: "query", required: true, schema: { type: "string" } }
        ],
        responses: {
          200: {
            description: "The file",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    name: { type: "string" },
                    mime: { type: "string" },
                    encoding: { type: "string", enum: ["text", "base64"] },
                    size: { type: "integer" },
                    updatedAt: { type: "number" },
                    data: { type: "string" }
                  }
                }
              }
            }
          },
          400: errResponse("Invalid path"),
          401: errResponse("Unauthorized"),
          404: errResponse("No such file")
        }
      }
    },
    "/send": {
      post: {
        operationId: "sendToPhone",
        summary: "Queue one action for the phone",
        description:
          "Whitelisted actions only: status, page (home|mail|ai|apps|money|ent|control), app (partial name), torch (on|off), clear, remote ('key|device'), url (https). The phone re-validates every action.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  code: { type: "string" },
                  action: {
                    type: "string",
                    enum: ["status", "page", "app", "torch", "clear", "remote", "url"]
                  },
                  arg: { type: "string" }
                },
                required: ["code", "action"]
              }
            }
          }
        },
        responses: {
          200: {
            description: "Queued",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    id: { type: "string" },
                    action: { type: "string" }
                  }
                }
              }
            }
          },
          400: errResponse("Unknown action or bad argument"),
          401: errResponse("Unauthorized"),
          429: errResponse("More than 30 commands a minute")
        }
      }
    },
    "/state": {
      get: {
        operationId: "phoneState",
        summary: "What the phone last reported",
        description:
          "Device name, whether it polled in the last 45 s, and the last 10 commands with their output.",
        parameters: [{ name: "code", in: "query", required: false, schema: { type: "string" } }],
        responses: {
          200: {
            description: "Device state and recent commands",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    name: { type: "string" },
                    online: { type: "boolean" },
                    lastSeen: { type: "number" },
                    commands: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          action: { type: "string" },
                          arg: { type: "string" },
                          status: { type: "string" },
                          output: { type: "string" },
                          createdAt: { type: "number" }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          401: errResponse("Unauthorized")
        }
      }
    },
    "/health": {
      get: {
        operationId: "healthCheck",
        summary: "Is the relay up",
        responses: { 200: { description: "Status and database check" } }
      }
    }
  }
};

/**
 * Returns the document with every local $ref expanded. ChatGPT's action importer is happiest with
 * a flat schema, so /openapi.json serves this while the source above stays readable.
 */
export function inlineSchema(doc) {
  const seen = new Set();
  const resolve = (node, depth = 0) => {
    if (node === null || typeof node !== "object" || depth > 60) return node;
    if (Array.isArray(node)) return node.map((item) => resolve(item, depth + 1));
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
      if (seen.has(node.$ref)) return {};
      seen.add(node.$ref);
      const target = node.$ref.slice(2).split("/").reduce((acc, key) => (acc ? acc[key] : undefined), doc);
      const expanded = target ? resolve(target, depth + 1) : {};
      seen.delete(node.$ref);
      return expanded;
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = resolve(value, depth + 1);
    return out;
  };
  return resolve(doc);
}

// Served to ChatGPT fully expanded: its action importer is happiest with a flat schema.
export const OPENAPI = inlineSchema(RAW);
