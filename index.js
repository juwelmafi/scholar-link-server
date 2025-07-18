require("dotenv").config();
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = process.env.PORT || 4000;
app.use(cors());
app.use(express.json());
const uri = process.env.MONGODB_URI;
const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decodedKey);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// MongoDB Client Setup
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Async DB connection + API routes
async function run() {
  try {
    // await client.connect();

    // * All collections here//
    const db = client.db("scholarLinkDB");
    const usersCollection = db.collection("users");
    const scholarshipCollection = db.collection("scholarships");
    const applicationCollection = db.collection("appliedScholarships");
    const reviewCollection = db.collection("reviews");

    //*********** Token verification here ********//

    // verfy firebase token//

    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized access" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      //verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    // verify admin//

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      console.log(email);
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access" });
      }
      next();
    };

    //***********Stripe Payment Intent********//

    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;

      if (!amount) {
        return res.status(400).json({ error: "Amount is required" });
      }

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount * 100, // Stripe accepts amount in cents/paisa
          currency: "usd", // use "usd" if you're testing with USD
          payment_method_types: ["card"],
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        console.error("Stripe Error:", err);
        res.status(500).json({ error: "Failed to create payment intent" });
      }
    });

    //***********/ user related apis **************//

    // GET: Get user by email
    app.get("/users/by-email", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      if (!email) {
        return res.status(400).send({ error: "Email query param is required" });
      }
      const user = await usersCollection.findOne({ email });

      if (!user) {
        return res.status(404).send({ error: "User not found" });
      }

      res.send(user);
    });

    // GET : get users by role

    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      const role = req.query.role;
      const query = role ? { role } : {};
      const result = await usersCollection.find(query).toArray();
      res.send(result);
    });

    // role base get

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;

      try {
        const user = await usersCollection.findOne(
          { email },
          { projection: { role: 1, email: 1, created_at: 1 } }
        );

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send(user);
      } catch (err) {
        console.error("Error fetching user role:", err);
        res
          .status(500)
          .send({ message: "Failed to get user role", error: err.message });
      }
    });

    //  PATCH: update users

    app.patch("/users/:id/role", async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role: role } }
      );
      res.send(result);
    });

    // DELETE: delete users

    app.delete("/users/:id", async (req, res) => {
      const id = req.params.id;
      const result = await usersCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // POST: Save user
    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        // update last login
        await usersCollection.updateOne(
          { email },
          { $set: { last_logged_in: new Date().toISOString() } }
        );

        return res
          .status(200)
          .send({ message: "User already exist", inserted: false });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    //***********/ ScholarShip related apis **************//

    app.get("/all-scholarships", async (req, res) => {
      try {
        const scholarships = await scholarshipCollection.find().toArray();
        res.send(scholarships);
      } catch (error) {
        console.error("Error fetching scholarships:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // GET: All Scholarships
    app.get("/scholarships", async (req, res) => {
      const search = req.query.search || "";
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;

      const searchRegex = new RegExp(search, "i");

      try {
        const query = {
          $or: [
            { scholarshipName: { $regex: searchRegex } },
            { universityName: { $regex: searchRegex } },
            { degree: { $regex: searchRegex } },
          ],
        };

        const total = await scholarshipCollection.countDocuments(query);

        const scholarships = await scholarshipCollection
          .find(query)
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray();

        const reviewList = await reviewCollection.find().toArray();

        const scholarshipsWithRating = scholarships.map((scholarship) => {
          const relatedReviews = reviewList.filter(
            (review) => review.scholarshipId === scholarship._id.toString()
          );

          const averageRating =
            relatedReviews.length > 0
              ? parseFloat(
                  (
                    relatedReviews.reduce(
                      (sum, r) => sum + Number(r.rating),
                      0
                    ) / relatedReviews.length
                  ).toFixed(1)
                )
              : null;

          return {
            ...scholarship,
            averageRating,
          };
        });

        res.send({
          scholarships: scholarshipsWithRating,
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch scholarships" });
      }
    });

    // GET: Single Scholarship by id
    app.get("/scholarships/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        const { ObjectId } = require("mongodb");
        const scholarship = await scholarshipCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!scholarship) {
          return res.status(404).send({ error: "Scholarship not found" });
        }

        res.send(scholarship);
      } catch (err) {
        res.status(500).send({ error: "Internal server error" });
      }
    });

    // DELETE: delete scholarship

    app.delete("/scholarships/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const result = await scholarshipCollection.deleteOne({
          _id: new ObjectId(id),
        });
        if (result.deletedCount === 1) {
          res.send({ message: "Scholarship deleted successfully" });
        } else {
          res.status(404).send({ error: "Scholarship not found" });
        }
      } catch (error) {
        res.status(500).send({ error: "Failed to delete scholarship" });
      }
    });

    // PUT: Edit scholarships

    app.put("/scholarships/:id", async (req, res) => {
      const id = req.params.id;
      const updatedData = req.body;

      try {
        const result = await scholarshipCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedData }
        );

        if (result.modifiedCount > 0) {
          res.send({ message: "Scholarship updated successfully" });
        } else {
          res
            .status(404)
            .send({ error: "Scholarship not found or no changes made" });
        }
      } catch (error) {
        res.status(500).send({ error: "Failed to update scholarship" });
      }
    });

    // GET: top scholarships by fee and postDate

    app.get("/top-scholarships", async (req, res) => {
      try {
        const scholarships = await scholarshipCollection
          .find()
          .sort({ applicationFee: 1, postDate: -1 })
          .limit(6)
          .toArray();

        const reviewList = await reviewCollection.find().toArray();
        // Map average rating to each scholarship
        const scholarshipsWithRating = scholarships.map((scholarship) => {
          const reviews = reviewList.filter(
            (review) => review.scholarshipId === scholarship._id.toString()
          );

          const averageRating =
            reviews.length > 0
              ? parseFloat(
                  (
                    reviews.reduce((sum, r) => sum + Number(r.rating), 0) /
                    reviews.length
                  ).toFixed(1)
                )
              : null;

          return {
            ...scholarship,
            averageRating,
          };
        });

        res.send(scholarshipsWithRating);
      } catch (error) {
        console.error(error);
        res.status(500).send({ error: "Failed to fetch scholarships" });
      }
    });

    // POST: add scholarship
    app.post("/scholarships", async (req, res) => {
      try {
        const scholarship = req.body;

        // Required fields check
        const requiredFields = [
          "scholarshipName",
          "universityName",
          "universityImage",
          "country",
          "city",
          "worldRank",
          "subjectCategory",
          "scholarshipCategory",
          "degree",
          "applicationFee",
          "serviceCharge",
          "deadline",
          "postDate",
          "postedBy",
        ];
        for (const field of requiredFields) {
          if (!scholarship[field]) {
            return res.status(400).send({ error: `Missing field: ${field}` });
          }
        }
        scholarship.createdAt = new Date();
        const result = await scholarshipCollection.insertOne(scholarship);
        res.send(result);
      } catch (error) {
        console.error("Failed to add scholarship:", error);
        res.status(500).send({ error: "Internal Server Error" });
      }
    });

    //***********/ Application related apis **************//

    // GET all applied scholarships
    app.get("/applied-scholarships", verifyFBToken, async (req, res) => {
      console.log("headers in all applied", req.headers);
      try {
        const sort = req.query.sort;
        let sortOption = {};
        if (sort === "date") {
          sortOption = { date: -1 }; // latest applications first
        } else if (sort === "deadline") {
          sortOption = { deadline: 1 }; // earliest deadline first
        }

        const result = await applicationCollection
          .find()
          .sort(sortOption)
          .toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch applications" });
      }
    });

    // GET /applications?userEmail=email@example.com
    app.get("/applications", verifyFBToken, async (req, res) => {
      const userEmail = req.query.userEmail;

      if (!userEmail) {
        return res
          .status(400)
          .json({ error: "userEmail query parameter is required" });
      }

      try {
        const applications = await applicationCollection
          .find({ userEmail })
          .toArray();
        res.status(200).json(applications);
      } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch applications" });
      }
    });

    //PUT Update application

    app.put("/applications/:id", async (req, res) => {
      const id = req.params.id;
      const updateDoc = {
        $set: req.body,
      };

      try {
        const result = await applicationCollection.updateOne(
          { _id: new ObjectId(id) },
          updateDoc
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to update application" });
      }
    });

    /// DELETE: delete application

    app.delete("/applications/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const result = await applicationCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).send({ error: "Failed to delete application" });
      }
    });

    // PATCH: edit application

    app.patch("/applications/:id", async (req, res) => {
      const id = req.params.id;
      const { applicationStatus } = req.body;

      try {
        const result = await applicationCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { applicationStatus } }
        );

        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ error: "Failed to update application status" });
      }
    });

    // POST: Submit application after payment
    app.post("/applied-scholarships", async (req, res) => {
      try {
        const application = req.body;

        // Basic validation
        if (
          !application.userEmail ||
          !application.userId ||
          !application.scholarshipId ||
          !application.paymentId
        ) {
          return res
            .status(400)
            .send({ error: "Missing required application fields" });
        }

        // Add submission timestamp
        application.createdAt = new Date();

        // Insert into collection
        const result = await applicationCollection.insertOne(application);

        res.send({ insertedId: result.insertedId });
      } catch (err) {
        console.error("Failed to submit application:", err);
        res.status(500).send({ error: "Failed to save application" });
      }
    });

    //***********/ Review related apis **************//

   
    //***********/ Count related apis **************//

    app.get("/stats", async (req, res) => {
      try {
        const scholarshipsCount =
          await scholarshipCollection.estimatedDocumentCount();
        const applicationsCount =
          await applicationCollection.estimatedDocumentCount();
        const reviewsCount = await reviewCollection.estimatedDocumentCount();

        res.send({
          scholarshipsCount,
          applicationsCount,
          reviewsCount,
        });
      } catch (err) {
        res
          .status(500)
          .send({ message: "Failed to fetch stats", error: err.message });
      }
    });

    //***********/ Analytics related apis **************//

    app.get("/analytics/applications-per-scholarship", async (req, res) => {
      try {
        const result = await applicationCollection
          .aggregate([
            {
              $group: {
                _id: "$subjectCategory",
                count: { $sum: 1 },
              },
            },
            {
              $project: {
                _id: 0,
                scholarshipName: "$_id",
                count: 1,
              },
            },
          ])
          .toArray();

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching chart data" });
      }
    });

    app.get("/analytics/user-roles", async (req, res) => {
      try {
        const result = await usersCollection
          .aggregate([
            {
              $group: {
                _id: "$role",
                count: { $sum: 1 },
              },
            },
            {
              $project: {
                role: "$_id",
                count: 1,
                _id: 0,
              },
            },
          ])
          .toArray();

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching user roles" });
      }
    });

    app.get("/analytics/daily-applications", async (req, res) => {
      try {
        const dailyApplications = await applicationCollection
          .aggregate([
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m-%d", date: "$date" },
                },
                count: { $sum: 1 },
              },
            },
            {
              $sort: { _id: 1 }, // sort by date ascending
            },
          ])
          .toArray();

        const formatted = dailyApplications.map((entry) => ({
          date: entry._id,
          count: entry.count,
        }));

        res.send(formatted);
      } catch (err) {
        console.error("Error fetching daily applications:", err);
        res.status(500).send({ message: "Failed to get daily applications" });
      }
    });

    //Example route
    app.get("/", (req, res) => {
      res.send("ScholarLink Server is running...");
    });

    // // MongoDB Ping
    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged MongoDB successfully");
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}
run().catch(console.dir);

// Start Express server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
