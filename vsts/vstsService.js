import * as pureService from "./vsts.pure.js";
import token from "../oauth/index.js";
import {getCurrentDomain, setCurrentDomain} from "../settings/settingsService.js";

angular.module('vstsChrome').service("vstsService", VstsService);


VstsService.$inject=['$q', 'memberService'];
function VstsService($q, memberService) {
    let resetGUID = "00000000-0000-0000-0000-000000000000";
    let initialize = $q.defer();
    const loginInitialize = $q.defer();

    const oauthFetch = async({url, params, ...obj}) => {
        const headers = new Headers();
        headers.append("Authorization", `Bearer ${(await token()).access_token}`);
        const urlToUse = `${url}${params ? `?${Object.entries(params).map(([k,v]) => `${k}=${v}`).join("&")}`:""}`
        const result = await (await fetch(urlToUse, {
            ...obj,
            headers
        })).json();
        return result;
    };

    getCurrentDomain().then((domainToUse) => {
        if (domainToUse) {
            checkLogin().then(() => {
                initialize.resolve("init ok");
            });
        } else {
            loginInitialize.reject("login missing");
            domainToUse = {};
        }
    });

    const getUrl = async() => (await getCurrentDomain()).vstsUrl;

    async function getProjects() {
        const {value} = await oauthFetch({
            method: "GET",
            url: (await getUrl()) + "/projects"
        });
        return value;
    }

    async function checkLogin() {
        try {
            await getProjects();
            loginInitialize.resolve("init ok");
        } catch (err) {
            loginInitialize.reject("login failed");
            throw "login failed";
        }
    }

    const getToApprovePullRequests = (pullRequests) => {
        let currentMember = memberService.getCurrentMember();
        const prs = pureService.getToApprovePullRequests(currentMember, pullRequests);
        setReminder(prs);
        return prs;
    };

    const getActiveComments = async({url}) => {
        const {value} = await oauthFetch({
            method: "GET",
            url: `${url}/threads`
        });
        return value.filter(({status}) => status === "active");
    };

    async function getMinePullRequests() {
        let currentMember = memberService.getCurrentMember();
        if(currentMember) {
            return oauthFetch({
                method: "GET",
                url: `${(await getUrl())}/git/pullRequests?creatorId=${currentMember.id}`
            }).then(
                (httpPullRequests) => httpPullRequests.value
            ).then((minePullRequests) => $q.all(minePullRequests.map((minePullRequest) => getFullPullRequest(minePullRequest))));
        }
        return $q.resolve([]);
    }

    function setReminder(toApprovePullRequests) {
        let nbToApprovePullRequests = toApprovePullRequests.length;
        if(nbToApprovePullRequests > 0) {
            chrome.browserAction.setBadgeText({text: nbToApprovePullRequests.toString()});
            chrome.browserAction.setBadgeBackgroundColor({color: "#FF9999"});
        } else {
            chrome.browserAction.setBadgeText({text: ""});
        };
    }

    const processComments = async(fullPr) => {
        fullPr.comments = await getActiveComments(fullPr);
    };

    function processPolicies(fullPr) {
        return getPolicyResult(fullPr).then((evaluations) => {
            let state;
            let policies = {};

            if(evaluations.length > 0) {
                let nbApproved = 0;
                evaluations.forEach((evaluation) => {
                    if(evaluation.configuration.isEnabled && evaluation.configuration.isBlocking) {
                        if(evaluation.status === "approved" && policies[evaluation.configuration.type.displayName] !== false) {
                            nbApproved++;
                            policies[evaluation.configuration.type.displayName] = true;
                        } else {
                            policies[evaluation.configuration.type.displayName] = false;
                        }
                    } else {
                        nbApproved++;
                    }
                });

                if(nbApproved === evaluations.length) {
                    state = "success";
                } else if (nbApproved === 0) {
                    state = "error";
                } else {
                    state = "warning";
                }
            } else {
                state = "none";
            }

            fullPr.evaluations = {
                policies: policies,
                state: state
            };
            return $q.resolve(fullPr);
        });
    }

    const getFullPullRequest = async(pr) => {
        const fullPr = await oauthFetch({
            method: "GET",
            url: pr.url
        });

        try { await processPolicies(fullPr); } catch (e) {}
        try { await processComments(fullPr); } catch (e) {}
        return fullPr;
    }

    function getPolicyResultByPRId(pr) {
        return getPolicies(pr, "pullRequestId");
    }

    function getPolicyResultByCRId(pr) {
        return getPolicies(pr, "codeReviewId");
    }

    async function getPolicies(pr, field) {
        return oauthFetch({
            method:"GET",
            url: `${(await getUrl()).replace("/_apis", "")}/${pr.repository.project.id}/_apis/policy/evaluations`,
            params: {
                artifactId: "vstfs:///CodeReview/CodeReviewId/" + pr.repository.project.id + "/" + pr[field],
                "api-version":"5.0-preview.1"
            }
        });
    }

    async function getVisits(pr, field) {
        return oauthFetch({
            method:"POST",
            url: `${(await getUrl()).replace("/_apis", "")}/_apis/visits/artifactStatsBatch`,
            params: {
                "api-version": "5.0-preview.1",
                "includeUpdatesSinceLastVisit": "true"
            },
            data: [
                {
                    "discussionArtifactId": `vstfs:///CodeReview/ReviewId/${pr.repository.project.id}%2F${pr["codeReviewId"]}`,
                    "artifactId": pr.artifactId.replace("%2f", "%2F")
                }
            ]
        });
    }

    function getPolicyResult(pr) {
        return getPolicyResultByPRId(pr).then(({value}) => {
            if (value.length === 0) {
                return getPolicyResultByCRId(pr);
            }
            return value;
        });
    }

    function getPullRequests() {
        return getPullRequestsList().then(function(pullRequests) {
            let promises = [];
            let fullPullRequests = [];
            pullRequests.forEach((pr) => {
                promises.push(getFullPullRequest(pr).then((fullPr) => {
                    //getVisits(fullPr).then(({newCommentsCount}) => console.log(newCommentsCount));
                    fullPullRequests.push(fullPr);
                }));
            });
            return $q.all(promises).then(() =>
                getMinePullRequests().then((minePullRequests) => ({
                    "all": fullPullRequests,
                    "toApprove": getToApprovePullRequests(fullPullRequests),
                    "mine": minePullRequests
                }))
            );
        });
    }

    async function getPullRequestsList() {
        return oauthFetch({
            method: "GET",
            url: (await getUrl()) + "/git/pullRequests",
            "params": {
                "$top": 250
            }
        }).then(
            (httpPullRequests) => httpPullRequests.value
        ).then(
            (httpPullRequests) => httpPullRequests.filter(({creationDate}) => moment(creationDate).isAfter(moment().subtract(3, 'months')))
        );
    }

    // async function getAllProjects() {
    //     return oauthFetch({
    //         method: "GET",
    //         url: (await getUrl()) + "/projects"
    //     }).then(({value}) => {
    //         let projects = value;
    //         let promises = [];
    //         let fullProjects = [];
    //         projects.forEach(function(project) {
    //             let promise = oauthFetch({
    //                 method: "GET",
    //                 url: project.url
    //             }).then((fullProject) => fullProjects.push(fullProject));
    //             promises.push(promise);
    //         });
    //         return $q.all(promises).then(() => fullProjects);
    //     });
    // }

    const getTeamMembers = async() => {
        let membersResult = new Map();

        const {"value": teams, ...t} = await oauthFetch({
            method: "GET",
            url: `${(await getUrl())}/teams`
        });

        await Promise.all(teams.flatMap(async({url, id}) => {
            const {"value": members} = await oauthFetch({
                method: "GET",
                url: `${url}/members`
            });
            members.forEach(({identity}) => {
                if(!membersResult.has(identity.id)) {
                    identity.teams = [id];
                    membersResult.set(identity.id, identity);
                } else {
                    const tmpMember = membersResult.get(identity.id);
                    tmpMember.teams.push(id);
                }
            });
        }));

        return [...membersResult.values()];
    };

    // function getTeamMembers() {
    //     return getAllProjects().then((projects) => {
    //         let promises = [];
    //         let members = new Map();
    //         projects.forEach((project) => {
    //             let promise = oauthFetch({
    //                 method: "GET",
    //                 url: project.defaultTeam.url + "/members"
    //             }).then(function(httpMembers) {
    //                 httpMembers.data.value.forEach(({identity}) => {
    //                     if(!members.has(identity.id)) {
    //                         identity.teams = [project.defaultTeam.id];
    //                         members.set(identity.id, identity);
    //                     } else {
    //                         tmpMember = members.get(identity.id);
    //                         tmpMember.teams.push(project.defaultTeam.id);
    //                     }
    //                 })
    //             });
    //             promises.push(promise);
    //         });
    //         return $q.all(promises).then(() => [...members.values()]);
    //     });
    // }

    async function getRepositories() {
        return oauthFetch({
            method: "GET",
            url: (await getUrl()) + "/git/repositories",
        }).then((httpRepositories) => httpRepositories.value);
    }

    async function setCredentials(credentials) {
        if(credentials.name) {
            const domainToUse = {
                name: credentials.name,
                vstsUrl: `https://dev.azure.com/${credentials.name}/_apis`,
                domainUrl: `https://dev.azure.com/${credentials.name}`
            };
            setCurrentDomain(domainToUse);
            initialize.resolve("init ok");
        } else {
            return $q.reject("missing arguments");
        }
    }

    function isInitialize() {
        return initialize.promise;
    }

    function isLoginInitialize() {
        return loginInitialize.promise;
    }

    function toggleAutoComplete(pr) {
        let currentMember = memberService.getCurrentMember();
        if(!currentMember) {
            return $q.reject("no current member");
        }
        return getFullPullRequest(pr).then((refreshPr) => {
            let data = {
                "autoCompleteSetBy": {
                    "id": refreshPr.autoCompleteSetBy !== undefined ? resetGUID : currentMember.id
                }
            };
            return oauthFetch({
                "method": "PATCH",
                "url": pr.url,
                "params": {
                    "api-version":"3.0"
                },
                "data": data
            }).catch(
                (error) => error
            );
        });
    }

    const fixAzureDevUrls = (item)  => {
        const rp = v => v.replace(/(:\/\/)(.*)@dev.azure.com\//, "$1dev.azure.com/");
        if (item && item.repository) {
            item.repository.remoteUrl = rp(item.repository.remoteUrl);
        }
        return item;
    };

    function getSuggestionForUser() {
        return getAllSuggestions()
            .then(suggestions => suggestions.map(suggestion => fixAzureDevUrls(suggestion)))
            .then(suggestions => {
                let currentMember = memberService.getCurrentMember();
                let promises = [];
                if(currentMember) {
                    suggestions.filter((suggestion) => suggestion.suggestion.length > 0).forEach((suggestion) => {
                        suggestion.suggestion.filter((sug) => sug.type === "pullRequest").forEach((sug) => {
                            let promise = oauthFetch({
                                method: "GET",
                                url: `${suggestion.repository.url}/commits?branch=${sug.properties.sourceBranch.replace('refs/heads/', '')}&$top=1`
                            }).then(({value}) => {
                                let [lastCommit] = value;
                                if(lastCommit && lastCommit.committer.email === currentMember.uniqueName) {
                                    return Object.assign({
                                        remoteUrl: suggestion.repository.remoteUrl,
                                        repositoryId: suggestion.repository.id
                                    }, sug);
                                }
                                return null;
                            });
                            promises.push(promise);
                        });
                    });
                }
                return $q.all(promises);
            });
    }

    function getAllSuggestions() {
        return getRepositories().then((respositories) => {
            let promises = [];
            respositories.forEach((repository) => {
                let promise = oauthFetch({
                    method: "GET",
                    url: repository.url + "/suggestions"
                }).then(({value}) => ({
                    repository: repository,
                    suggestion: value
                }));
                promises.push(promise);
            });
            return $q.all(promises);
        });
    }

    return {
        isInitialize: isInitialize,
        isLoginInitialize: isLoginInitialize,
        getTeamMembers,
        getPullRequests: getPullRequests,
        setCredentials: setCredentials,
        toggleAutoComplete: toggleAutoComplete,
        getSuggestionForUser: getSuggestionForUser,
        getProjects: getProjects
    };
}