const express = require("express");
const axios = require("axios");
const { db } = require("../../handlers/db.js");
const { logAudit } = require("../../handlers/auditlog");

const router = express.Router();

/**
 * Middleware to verify if the user is an administrator.
 * @param {Object} req - The request object
 * @param {Object} res - The response object
 * @param {Function} next - The next middleware function
 * @returns {void}
 */
function isAdmin(req, res, next) {
    if (!req.user || req.user.admin !== true) {
        return res
            .status(403)
            .json({ message: "Forbidden: Admin access required" });
    }
    next();
}

/**
 * PUT /instances/edit/:id
 * Handles the editing of an existing instance with comprehensive validation
 */
router.put("/instances/edit/:id", isAdmin, async (req, res) => {
    try {
        // Validate input parameters
        if (!req.user) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const { id } = req.params;
        if (!id || typeof id !== "string") {
            return res.status(400).json({ message: "Invalid instance ID" });
        }

        const { Image, Memory, Cpu } = req.body;

        // Validate request body
        if (!Image && !Memory && !Cpu) {
            return res.status(400).json({
                message:
                    "At least one update parameter (Image, Memory, Cpu) is required",
            });
        }

        // Validate memory and CPU if provided
        if (Memory && (isNaN(Memory) || Memory <= 0)) {
            return res
                .status(400)
                .json({ message: "Memory must be a positive number" });
        }

        if (Cpu && (isNaN(Cpu) || Cpu <= 0)) {
            return res
                .status(400)
                .json({ message: "CPU must be a positive number" });
        }

        // Get instance from database
        const instance = await db.get(`${id}_instance`);
        if (!instance) {
            return res.status(404).json({ message: "Instance not found" });
        }

        // Validate node information
        if (
            !instance.Node ||
            !instance.Node.address ||
            !instance.Node.port ||
            !instance.Node.apiKey
        ) {
            return res
                .status(500)
                .json({
                    message: "Invalid node configuration for this instance",
                });
        }

        // Prepare and send request to node
        const requestData = prepareEditRequestData(
            instance,
            Image,
            Memory,
            Cpu,
        );
        const response = await axios(requestData);

        if (!response.data || !response.data.newContainerId) {
            throw new Error("Invalid response from node API");
        }

        // Update database records
        const updatedInstance = await updateInstanceInDatabase(
            id,
            instance,
            Image,
            Memory,
            Cpu,
            response.data.newContainerId,
        );

        // Log the audit event
        await logAudit(
            req.user.userId,
            req.user.username,
            "instance:edit",
            req.ip,
            {
                oldContainerId: id,
                newContainerId: response.data.newContainerId,
                changes: { Image, Memory, Cpu },
            },
        );

        res.status(200).json({
            message: "Instance updated successfully",
            oldContainerId: id,
            newContainerId: response.data.newContainerId,
            changes: {
                Image: Image ? "updated" : "unchanged",
                Memory: Memory ? "updated" : "unchanged",
                Cpu: Cpu ? "updated" : "unchanged",
            },
        });
    } catch (error) {
        console.error("Error updating instance:", error);

        const statusCode = error.response?.status || 500;
        const errorMessage =
            error.response?.data?.message ||
            error.message ||
            "Failed to update instance";

        res.status(statusCode).json({
            message: errorMessage,
            details:
                process.env.NODE_ENV === "development"
                    ? error.stack
                    : undefined,
        });
    }
});

/**
 * Prepares the request data for editing an instance
 * @param {Object} instance - The instance object
 * @param {string} Image - New image (optional)
 * @param {number} Memory - New memory (optional)
 * @param {number} Cpu - New CPU (optional)
 * @returns {Object} Axios request configuration
 */
function prepareEditRequestData(instance, Image, Memory, Cpu) {
    return {
        method: "put",
        url: `http://${instance.Node.address}:${instance.Node.port}/instances/edit/${instance.ContainerId}`,
        auth: {
            username: "Skyport",
            password: instance.Node.apiKey,
        },
        headers: {
            "Content-Type": "application/json",
            "X-Requested-By": "Skyport-API",
        },
        data: {
            Image: Image || instance.Image,
            Memory: Memory || instance.Memory,
            Cpu: Cpu || instance.Cpu,
            VolumeId: instance.VolumeId,
        },
        timeout: 10000, // 10 second timeout
        validateStatus: (status) => status < 500, // Don't throw for 4xx errors
    };
}

/**
 * Updates all database records related to an instance
 * @param {string} id - Old container ID
 * @param {Object} instance - Original instance data
 * @param {string} Image - New image
 * @param {number} Memory - New memory
 * @param {number} Cpu - New CPU
 * @param {string} newContainerId - New container ID
 * @returns {Promise<Object>} The updated instance
 */
async function updateInstanceInDatabase(
    id,
    instance,
    Image,
    Memory,
    Cpu,
    newContainerId,
) {
    const updatedInstance = {
        ...instance,
        Image: Image || instance.Image,
        Memory: Memory || instance.Memory,
        Cpu: Cpu || instance.Cpu,
        ContainerId: newContainerId,
        updatedAt: new Date().toISOString(),
    };

    // Use transaction for atomic updates
    await db
        .batch()
        .set(`${newContainerId}_instance`, updatedInstance)
        .del(`${id}_instance`)
        .write();

    // Update user instances
    await updateUserInstances(instance.User, id, updatedInstance);

    // Update global instances
    await updateGlobalInstances(id, updatedInstance);

    return updatedInstance;
}

/**
 * Updates the instances list for a specific user
 * @param {string} userId - User ID
 * @param {string} oldContainerId - Old container ID
 * @param {Object} updatedInstance - Updated instance data
 * @returns {Promise<void>}
 */
async function updateUserInstances(userId, oldContainerId, updatedInstance) {
    const userInstances = (await db.get(`${userId}_instances`)) || [];
    const instanceIndex = userInstances.findIndex(
        (inst) => inst.ContainerId === oldContainerId,
    );

    if (instanceIndex !== -1) {
        userInstances[instanceIndex] = {
            ...userInstances[instanceIndex],
            ...updatedInstance,
        };
        await db.set(`${userId}_instances`, userInstances);
    }
}

/**
 * Updates the global instances list
 * @param {string} oldContainerId - Old container ID
 * @param {Object} updatedInstance - Updated instance data
 * @returns {Promise<void>}
 */
async function updateGlobalInstances(oldContainerId, updatedInstance) {
    const globalInstances = (await db.get("instances")) || [];
    const instanceIndex = globalInstances.findIndex(
        (inst) => inst.ContainerId === oldContainerId,
    );

    if (instanceIndex !== -1) {
        globalInstances[instanceIndex] = {
            ...globalInstances[instanceIndex],
            ...updatedInstance,
        };
        await db.set("instances", globalInstances);
    }
}

module.exports = router;
