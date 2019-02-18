import * as Hapi from 'hapi';
import * as Boom from "boom";
// import * as GoogleCloudStorage from "@google-cloud/storage";

import database from "../../";
import { IServerConfigurations } from "../../configurations/index";

import { sendAssignmentReviewPendingEmail, sendAssignmentReviewCompleteEmail } from "../../sendEmail";

// Helper function to generate UIDs
function generateUID() {
    // I generate the UID from two parts here
    // to ensure the random number provide enough bits.
    let firstPart = ((Math.random() * 46656) | 0).toString(36);
    let secondPart = ((Math.random() * 46656) | 0).toString(36);
    firstPart = ("000" + firstPart).slice(-3);
    secondPart = ("000" + secondPart).slice(-3);
    return firstPart + secondPart;
}

// TODO: Add support for tracking assignmnt completion time.

export default class AssignmentController {
    private configs: IServerConfigurations;
    private database: any;

    constructor(configs: IServerConfigurations, database: any) {
        this.database = database;
        this.configs = configs;
    }

    public postExerciseSubmission(request, h) {
        return new Promise((resolve, reject) => {

            database('course_enrolments').select('*')
                .where({
                    'studentId': request.userId,
                    'courseId': request.params.courseId,
                })
                .then((rows) => {
                    /**
                     * student can only submit the assignment of the courses in which they are enrolled.
                     */
                    if (rows.length > 0) {
                        return Promise.resolve({ canSubmit: true });
                    } else {
                        reject(Boom.expectationFailed("User can't submit an assignment unless enrolled in course"));
                        return Promise.resolve({ canSubmit: false });
                    }
                })
                .then((response) => {
                    if (response.canSubmit === true) {
                        let count, student, reviewer;
                        /** Validate the exerciseId does the exercise exist or not not */
                        database('exercises').select()
                            .where('id', request.params.exerciseId)
                            .then((rows) => {
                                if (rows.length < 1) {
                                    reject(Boom.notFound('The exercise with the given ID is not found.'));
                                    return Promise.reject("Rejected");
                                }
                                else {
                                    return Promise.resolve(rows[0]);
                                }
                            })
                            .then((exercise) => {
                                return database('submissions').count('id as count').where({
                                    'submissions.userId': request.userId,
                                    'exerciseId': request.params.exerciseId
                                }).then((rows) => {
                                    count = rows[0].count;
                                    return Promise.resolve(exercise);
                                });
                            })
                            .then((exercise) => {
                                // let facilitatorIdQuery;

                                /** Not in work */
                                if (exercise.reviewType === 'manual') {
                                    return Promise.resolve({
                                        exerciseId: request.params.exerciseId,
                                        userId: request.userId,
                                        completed: 1,
                                        state: 'completed',
                                        completedAt: new Date()
                                    });
                                }
                                /** Not in work */
                                else if (exercise.reviewType === 'automatic') {
                                    return Promise.resolve({
                                        exerciseId: request.params.exerciseId,
                                        userId: request.userId,
                                        submitterNotes: request.payload.notes,
                                        // files: JSON.stringify(request.payload.files),
                                        state: 'completed',
                                        completed: 1,
                                        completedAt: new Date()
                                    });

                                }

                                else if (exercise.reviewType === 'peer' || exercise.reviewType === 'facilitator') {

                                    let reviewerIdQuery, facilitatorIdQuery;

                                    /** Finding the facilitator of the student center */
                                    facilitatorIdQuery =
                                        database('users').select('users.center as studentCenter').where({
                                            'users.id': request.userId
                                        })
                                            .then((rows) => {
                                                /** Find the student center. */
                                                if (rows.length < 1) {
                                                    reject(Boom.expectationFailed("Student have no center assigned can't"
                                                        + "submit assignment."));
                                                    return Promise.reject("Rejected");
                                                } else {
                                                    const { studentCenter } = rows[0];
                                                    return Promise.resolve(studentCenter);

                                                }
                                            })
                                            .then((studentCenter) => {
                                                /** Find the facilitor of the student. */
                                                return database('user_roles').select('userId as reviewerID').where({
                                                    'user_roles.center': studentCenter,
                                                    'user_roles.roles': 'facilitator',
                                                });
                                            })
                                            .then((rows) => {
                                                if (rows.length < 1) {
                                                    const { facilitatorEmails } = this.configs;

                                                    /** 
                                                     * If there is no facilitator then assign the assigment
                                                     * to the default Facilitator.
                                                     */
                                                    if (facilitatorEmails.length < 1) {
                                                        reject(Boom.expectationFailed("No facilitators in config add them."));
                                                        return Promise.reject("Rejected");
                                                    }

                                                    const index = (Math.random() * facilitatorEmails.length) | 0;

                                                    let facilitatorEmail = facilitatorEmails[index];

                                                    return database('users').select('users.id as reviewerID').where({
                                                        'users.email': facilitatorEmail
                                                    });
                                                } else {
                                                    return Promise.resolve(rows);
                                                }
                                            })
                                            .then((rows) => {
                                                // if no facilitator exist than just
                                                // throw error of no facilitator found for the center.
                                                if (rows.length < 1) {
                                                    reject(Boom.expectationFailed("There is no facilitator "
                                                        + "added on the platform."));
                                                    return Promise.reject("Rejected");
                                                } else {
                                                    return Promise.resolve(rows);
                                                }
                                            });
                                    /** 
                                     * if any student has already completed the assignment,
                                     * then assign the assignment to the student.
                                     */
                                    if (exercise.reviewType === 'peer') {
                                        reviewerIdQuery =
                                            database('submissions')
                                                .select('submissions.userId as reviewerID')
                                                .innerJoin(
                                                    'course_enrolments', 'submissions.userId',
                                                    'course_enrolments.studentId'
                                                )
                                                .where({
                                                    'submissions.completed': 1,
                                                    'submissions.exerciseId': request.params.exerciseId,
                                                    'course_enrolments.courseId': request.params.courseId
                                                })
                                                .orderByRaw('RAND()')
                                                .limit(1);

                                    } else {
                                        reviewerIdQuery = facilitatorIdQuery;
                                    }

                                    return reviewerIdQuery.then((rows) => {
                                        /** extracting the reviewerId */
                                        let reviewerId;
                                        if (rows.length < 1 && exercise.reviewType === 'peer') {
                                            return facilitatorIdQuery.then((rows) => {
                                                reviewerId = rows[0].reviewerID;
                                                return Promise.resolve({ reviewerId: reviewerId });
                                            });
                                        } else {
                                            let reviewerId = rows[0].reviewerID;
                                            return Promise.resolve({ reviewerId: reviewerId });
                                        }
                                    })
                                        .then((response) => {
                                            return Promise.resolve({
                                                exerciseId: request.params.exerciseId,
                                                userId: request.userId,
                                                submitterNotes: request.payload.notes,
                                                // files: JSON.stringify(request.payload.files),
                                                state: 'pending',
                                                completed: 0,
                                                peerReviewerId: response.reviewerId,
                                            });
                                        });
                                }


                            })
                            .then((queryData) => {
                                /**
                                 * Create a new submission if there doesn't exist one 
                                 * or if exist update it as a complete new assignment.
                                 */
                                let submissionInsertQuery;
                                if (count >= 1) {
                                    // update the existing submssion.
                                    submissionInsertQuery =
                                        database('submissions').select(`submissions.id`)
                                            .where({
                                                'submissions.userId': request.userId,
                                                'exerciseId': request.params.exerciseId,
                                            })
                                            .update(queryData)
                                            .then((row) => {
                                                return Promise.resolve({
                                                    reviewerId: queryData.peerReviewerId,
                                                    studentId: queryData.userId
                                                });
                                            });
                                } else {
                                    // create a new submission.
                                    submissionInsertQuery =
                                        database('submissions').insert(queryData)
                                            .then((rows) => {
                                                return Promise.resolve({
                                                    reviewerId: queryData.peerReviewerId,
                                                    studentId: queryData.userId
                                                });
                                            });

                                }

                                submissionInsertQuery.then((response) => {
                                    /**
                                     * Finding the student and the reviewer details to send the
                                     * email to them about assignment submission.
                                     */
                                    let studentQuery = database('users')
                                        .select('users.email', 'users.name')
                                        .where({
                                            'users.id': response.studentId
                                        })
                                        .then(rows => {
                                            student = rows[0];
                                            return Promise.resolve();
                                        });

                                    let reviewerQuery =
                                        database('users').select('users.email', 'users.name')
                                            .where({ 'users.id': response.reviewerId })
                                            .then((rows) => {
                                                reviewer = rows[0];
                                                return Promise.resolve();
                                            });

                                    return Promise.all([studentQuery, reviewerQuery])
                                        .then(() => {
                                            return database('submissions')
                                                .select(
                                                    // Submissions table fields
                                                    'submissions.id as submissionId',
                                                    'exercises.name as exerciseName',
                                                    'exercises.slug as exerciseSlug',
                                                    'submissions.state',
                                                    'submissions.completed'
                                                )
                                                .innerJoin('exercises', 'exercises.id', 'submissions.exerciseId')
                                                .where({
                                                    'submissions.userId': request.userId,
                                                    'exerciseId': request.params.exerciseId
                                                });
                                        });

                                })
                                    .then((rows) => {
                                        // send email using aws to the student and the reviewer
                                        sendAssignmentReviewPendingEmail(student, reviewer, rows[0]);
                                        resolve(rows[0]);
                                    });
                            });
                    }
                });
        });
    }

    public uploadExerciseAssignment(request: Hapi.request, reply: Hapi.IReply) {
        // NEEd to be rewritten for s3: TODO

        // let gcs = GoogleCloudStorage({
        //     projectId: this.configs.googleCloud.projectId,
        //     keyFilename: __dirname + '/../' + this.configs.googleCloud.keyFilename
        // });

        // let bucket = gcs.bucket(this.configs.googleCloud.assignmentsBucket);

        // var fileData = request.payload.file;
        // if (fileData) {
        //     let dir = request.userId + '/' + request.params.courseId + '/' + request.params.exerciseId;
        //     let name = generateUID() + '.' + fileData.hapi.filename;
        //     let filePath = dir + '/' + name;
        //     let file = bucket.file(filePath);

        //     let stream = file.createWriteStream({
        //         metadata: {
        //             contentType: fileData.hapi.headers['content-type']
        //         }
        //     });

        //     stream.on('error', (err) => {
        //         console.log(err);
        //         return reply(Boom.badImplementation("There was some problem uploading the file. Please try again."));
        //     });
        //     stream.on('finish', () => {
        //         return reply({
        //             "success": true,
        //             "filePath": "https://storage.googleapis.com/" + this.configs.googleCloud.assignmentsBucket + '/' + filePath
        //         });
        //     });

        //     stream.end(fileData._data);
        // }
    }

    public getExerciseSubmissions(request, h) {
        return new Promise((resolve, reject) => {
            // query to find all the submission of particular exerciseId
            let submissionQuery =
                database('submissions')
                    .select(
                        // Submissions table fields
                        'submissions.id', 'submissions.exerciseId', 'submissions.submittedAt', 'submissions.submitterNotes',
                        'submissions.files', 'submissions.notesReviewer', 'submissions.state', 'submissions.completed',
                        'submissions.completedAt',
                        // Reviewer details
                        'reviewUsers.name as reviewerName', 'reviewUsers.id as reviewerId',
                        'reviewUsers.profilePicture as reviewerProfilePicture',
                        // 'reviewUsers.facilitator as isReviewerFacilitator',
                        // Submitter Details
                        'users.name as submitterName', 'users.id as submitterId', 'users.profilePicture as submitterProfilePicture',
                        // 'users.facilitator as isSubmitterFacilitator'
                    )
                    .leftJoin(database.raw('users reviewUsers'), 'submissions.peerReviewerId', 'reviewUsers.id')
                    .leftJoin('users', 'submissions.userId', 'users.id');

            // Clauses to search the exercisesId
            let whereClause = {
                'submissions.exerciseId': request.params.exerciseId
            };

            // Wether to search submissions of the current user or not.
            if (request.query.submissionUsers === 'current') {
                whereClause['submissions.userId'] = request.userId;
            }

            // the state of the submissions of the student.
            if (request.query.submissionState !== 'all') {
                whereClause['submissions.state'] = request.query.submissionState;
            }

            submissionQuery.where(whereClause)
                .then((rows) => {
                    // parsing the files
                    let submissions = [];
                    for (let i = 0; i < rows.length; i++) {
                        let submission = rows[i];
                        if (submission.files !== null) {
                            submission.files = JSON.parse(submission.files);
                        }
                        submissions.push(submission);
                    }

                    resolve({ "data": submissions });
                });
        });
    };

    public getExerciseSubmissionById(request, h) {
        return new Promise((resolve, reject) => {
            // for searching single assignment submission by submissionId
            database('submissions')
                .select('submissions.id', 'submissions.exerciseId', 'submissions.userId',
                    'submissions.submittedAt', 'submissions.submitterNotes', 'submissions.files',
                    'submissions.notesReviewer', 'submissions.state', 'submissions.completed',
                    'submissions.completedAt', 'submissions.submittedAt',
                    'users.name as reviewerName',
                    'users.id as reviewerId', 'users.profilePicture as reviewerProfilePicture')
                .leftJoin('users', 'submissions.peerReviewerId', 'users.id')
                .where({ 'submissions.id': request.params.submissionId })
                .then((rows) => {
                    let submission = rows[0];
                    if (submission.files !== null) {
                        submission.files = JSON.parse(submission.files);
                    }
                    resolve(submission);
                });
        });

    }

    public getPeerReviewRequests(request: Hapi.Request, reply: Hapi.IReply) {
        return new Promise((resolve, reject) => {
            // Hackish Solution to show all the review to the Developer.
            let developerEmails = [
                'amar17@navgurukul.org',
                'diwakar17@navgurukul.org',
                // 'lalita17@navgurukul.org',
                // 'kanika17@navgurukul.org',
                // 'rani17@navgurukul.org',
                // 'khusboo17@navgurukul.org',
            ];

            database('users')
                .select('users.email')
                .where({ 'users.id': request.userId })
                .then((rows) => {
                    if (developerEmails.indexOf(rows[0].email) > -1) {
                        // Show all the Peer Review to the user when the User is Developer.
                        return Promise.resolve({
                            whereClause: {}
                        });
                    }
                    // if not a developer show him the assignmnt assign to him for reviewing
                    return Promise.resolve({
                        whereClause: {
                            'submissions.peerReviewerId': request.userId
                        }
                    });
                })
                // *************** Hackish solution till here ********************.

                .then((response) => {
                    database('submissions')
                        .select(
                            // Submissions table
                            'submissions.id', 'submissions.exerciseId', 'submissions.submittedAt', 'submissions.submitterNotes',
                            'submissions.files', 'submissions.files', 'submissions.notesReviewer', 'submissions.state', 'submissions.completed',
                            'submissions.completedAt', 'submissions.submittedAt', 'submissions.submittedAt',
                            // Exercises Table
                            'exercises.id as exerciseId', 'exercises.parentExerciseId as parentExerciseId', 'exercises.courseId',
                            'exercises.name as exerciseName', 'exercises.slug as exerciseSlug', 'exercises.sequenceNum as exerciseSequenceNum',
                            'exercises.reviewType', 'exercises.content as exerciseContent',
                            // Users table
                            'users.id as submitterId', 'users.name as submitterName', 'users.profilePicture as submitterProfilePicture'
                            // 'users.facilitator as isSubmitterFacilitator'
                        )
                        .innerJoin('exercises', 'submissions.exerciseId', 'exercises.id')
                        .innerJoin('users', 'submissions.userId', 'users.id')
                        .where(response.whereClause)
                        .orderBy('submittedAt', 'desc')
                        .then((rows) => {
                            let submissions = [];
                            for (let i = 0; i < rows.length; i++) {
                                let submission = rows[i];
                                if (submission.files !== null) {
                                    submission.files = JSON.parse(submission.files);
                                }
                                submissions.push(submission);
                            }
                            resolve({ "data": submissions });
                        });
                });
        });

    }


    public editPeerReviewRequest(request, h) {

        return new Promise((resolve, reject) => {
            // submitting the review of the submitted assiugnment

            const usersId = 32;
            database('submissions')
                .select('*')
                .innerJoin('mentors', 'userId', 'mentee')
                .innerJoin('users', 'submissions.userId', 'users.id')
                .where({ 'submissions.id': request.params.submissionId })
                .then((rows) => {

                    // validate the submissionId
                    if (rows.length < 1) {
                        reject(Boom.notFound("A submission with the given ID does not exist."));
                        return Promise.reject("Rejected");
                    }
                    let submission = rows[0];
                    // submissions once reviewed shouldn't be reviewed again.
                    if (submission.state !== 'pending') {
                        reject(Boom.expectationFailed("The given submission has already been reviewed."));
                        return Promise.reject("Rejected");
                    }
                    return Promise.resolve(submission);
                }).then((submission) => {

                    let updateFields = {
                        notesReviewer: request.payload.notes
                    };

                    return database('user_roles').select('*')
                        .where({
                            'roles': 'facilitator',
                            'center': submission.center
                        }).then((rows) => {

                            let usersFacilator = rows[0];
                            //console.log(usersFacilator.userId);

                            if (
                                usersId === submission.peerReviewerId
                                || usersId === submission.mentor
                                || usersId === usersFacilator.userId
                            ) {
                                if (request.payload.approved) {
                                    updateFields['completed'] = 1;
                                    updateFields['state'] = 'completed';
                                    updateFields['completedAt'] = new Date();
                                    updateFields['completedBy'] = usersId;
                                } else {
                                    updateFields['completed'] = 0;
                                    updateFields['state'] = 'rejected';
                                    updateFields['completedBy'] = usersId;
                                }

                            } else {


                                reject(Boom.notFound("A submission with the given ID does not exist."));
                                return Promise.reject("Rejected");
                            }


                            return Promise.resolve({ updateFields, submission });

                        });



                })
                .then(({ updateFields, submission }) => {


                    //console.log("i am end here in the right position : ", updateFields, submission);

                    // Updating the submission with the reviewers review.
                    database('submissions')
                        .update(updateFields)
                        .where({ id: request.params.submissionId })
                        .then((rows) => {
                            /**
                             *  Finding the student and the reviewer details to send email
                             * to them about the assignment review.
                            */
                            let student, reviewer;
                            let studentQ = database('users').select('*')
                                .where({
                                    'users.id': submission.userId
                                })
                                .then((rows) => {
                                    student = rows[0];
                                    return Promise.resolve();
                                });

                            let reviewerQ = database('users').select('*')
                                .where({
                                    'users.id': submission.userId
                                })
                                .then((rows) => {
                                    reviewer = rows[0];
                                    return Promise.resolve();
                                });

                            return Promise.all([studentQ, reviewerQ])
                                .then(() => {
                                    // send email for submission review completion
                                    return database('submissions')
                                        .select('exercises.courseId', 'exercises.slug',
                                            'exercises.name')
                                        .innerJoin('exercises', 'exercises.id', 'submissions.exerciseId')
                                        .where({
                                            'submissions.id': submission.id
                                        })
                                        .then((rows) => {
                                            return sendAssignmentReviewCompleteEmail(student, reviewer, rows[0]);
                                        });
                                });
                        })
                        .then(() => {
                            resolve({ 'success': true });
                        });
                });
        });
    }
}
