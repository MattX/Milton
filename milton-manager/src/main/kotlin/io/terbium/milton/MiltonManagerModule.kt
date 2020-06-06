/*
 * Copyright 2020 The Milton Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package io.terbium.milton

import com.google.inject.AbstractModule
import com.google.inject.TypeLiteral
import com.typesafe.config.ConfigFactory
import javax.inject.Qualifier

class MiltonManagerModule : AbstractModule() {
    override fun configure() {
        val conf = ConfigFactory.load()
        val secretConf = ConfigFactory.load("secrets")
        bind(String::class.java)
                .annotatedWith(GoogleAuthClientId::class.java)
                .toInstance(conf.getString("milton.googleAuthClientId")!!)
        bind(String::class.java)
                .annotatedWith(AlgoliaAccount::class.java)
                .toInstance(secretConf.getString("secrets.algoliaAccount")!!)
        bind(String::class.java)
                .annotatedWith(AlgoliaSecret::class.java)
                .toInstance(secretConf.getString("secrets.algoliaSecret")!!)
        bind(String::class.java)
                .annotatedWith(ProcessorHost::class.java)
                .toInstance(conf.getString("milton.processorHost")!!)
        bind(String::class.java)
                .annotatedWith(ProjectName::class.java)
                .toInstance(conf.getString("milton.projectName")!!)
        val botSecrets = secretConf.getConfig("bots").entrySet()
                .map { it.key to (it.value.unwrapped() as String) }
                .toMap()
        bind(object : TypeLiteral<Map<String, @JvmSuppressWildcards String>>() {})
                .annotatedWith(BotSecrets::class.java)
                .toInstance(botSecrets)
    }
}

@Qualifier
@Target(AnnotationTarget.FIELD, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class GoogleAuthClientId

@Qualifier
@Target(AnnotationTarget.FIELD, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class AlgoliaAccount

@Qualifier
@Target(AnnotationTarget.FIELD, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class AlgoliaSecret

@Qualifier
@Target(AnnotationTarget.FIELD, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class ProcessorHost

@Qualifier
@Target(AnnotationTarget.FIELD, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class ProjectName

@Qualifier
@Target(AnnotationTarget.FIELD, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class BotSecrets
