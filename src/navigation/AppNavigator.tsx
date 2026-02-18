import React from "react";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import DashboardScreen from "../screens/DashboardScreen";
import TransactionsScreen from "../screens/TransactionsScreen";
import SuppliersScreen from "../screens/SuppliersScreen";
import ReportsScreen from "../screens/ReportsScreen";
import AddEntryScreen from "../screens/AddEntryScreen";
import SupplierDetailScreen from "../screens/SupplierDetailScreen";

import { theme } from "../theme";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const MyTheme = {
	...DefaultTheme,
	colors: {
		...DefaultTheme.colors,
		background: theme.colors.background,
		primary: theme.colors.primary,
	},
};

function Tabs() {
	return (
		<Tab.Navigator
			screenOptions={({ route }) => ({
				headerStyle: {
					backgroundColor: theme.colors.primary,
				},
				headerTintColor: "#fff",
				tabBarActiveTintColor: theme.colors.primary,
				tabBarInactiveTintColor: theme.colors.textSecondary,
				tabBarStyle: {
					backgroundColor: theme.colors.card,
				},
				tabBarIcon: ({ color, size }) => {
					let iconName: any;

					if (route.name === "Dashboard") iconName = "home-outline";
					else if (route.name === "Transactions") iconName = "list-outline";
					else if (route.name === "Suppliers") iconName = "people-outline";
					else if (route.name === "Reports") iconName = "bar-chart-outline";

					return <Ionicons name={iconName} size={size} color={color} />;
				},
			})}
		>
			<Tab.Screen name="Dashboard" component={DashboardScreen} />
			<Tab.Screen name="Transactions" component={TransactionsScreen} />
			<Tab.Screen name="Suppliers" component={SuppliersScreen} />
			<Tab.Screen name="Reports" component={ReportsScreen} />
		</Tab.Navigator>
	);
}

export default function AppNavigator() {
	return (
		<NavigationContainer theme={MyTheme}>
			<Stack.Navigator>
				<Stack.Screen
					name="Main"
					component={Tabs}
					options={{ headerShown: false }}
				/>
				<Stack.Screen
					name="AddEntry"
					component={AddEntryScreen}
					options={{
						title: "Add Entry",
						headerStyle: { backgroundColor: theme.colors.primary },
						headerTintColor: "#fff",
					}}
				/>
				<Stack.Screen
					name="SupplierDetail"
					component={SupplierDetailScreen}
					options={{
						title: "Supplier Details",
						headerStyle: { backgroundColor: theme.colors.primary },
						headerTintColor: "#fff",
					}}
				/>
			</Stack.Navigator>
		</NavigationContainer>
	);
}
